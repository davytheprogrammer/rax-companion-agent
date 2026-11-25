'use strict';
// What Hands can do, one action per entry: resolve the target from the screen
// map (or the screenshot), fly the thread to it so the person sees where the
// click lands, then act through the sidecar (hands.ps1). Every action returns
// { ok, report, refused?, error?, settle?, lookAfter? } and never throws for
// an ordinary failure: the report goes back to the model, which tries another
// way or stops and says so.
//
// Dependencies are injected (probe, hands, shell, screen conversions, the
// thread, file search, app launch) so the registry runs in tests with fakes.
const path = require('path');
const { chooseElement, overlap } = require('../guide/chooser');
const { sensitiveTarget } = require('../guide/sensitive');

const VK = { enter: 0x0D, return: 0x0D, escape: 0x1B, esc: 0x1B, tab: 0x09, backspace: 0x08, delete: 0x2E, del: 0x2E, space: 0x20, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27, ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5B, insert: 0x2D };
for (let i = 1; i <= 12; i++) VK['f' + i] = 0x6F + i;
for (let c = 0; c < 26; c++) VK[String.fromCharCode(97 + c)] = 0x41 + c;
for (let d = 0; d < 10; d++) VK[String(d)] = 0x30 + d;
Object.assign(VK, { '=': 0xBB, '-': 0xBD, ',': 0xBC, '.': 0xBE, '/': 0xBF, '`': 0xC0, '[': 0xDB, '\\': 0xDC, ']': 0xDD, "'": 0xDE, plus: 0xBB, minus: 0xBD });

const PAGE_TICKS = 8;            // wheel ticks per "page"
const MAX_PAGES = 5;
const MAX_WAIT_S = 10;
const MAX_TEXT = 1500;           // one type action; the sidecar sends it as one burst of input
const NOT_A_FIELD = /^(?:tab ?item|tab|button|menu ?item|menu ?bar|menu|hyperlink|list ?item|tree ?item|header ?item|check ?box|radio ?button|split ?button|title ?bar|scroll ?bar|slider|image|separator)$/i;
const HOME_FOLDERS = ['Documents', 'Desktop', 'Downloads'];

function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function centre(rect) { return { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) }; }

// "ctrl+s" -> [0x11, 0x53]; unknown names -> null.
function parseKeys(keys) {
  const parts = String(keys || '').toLowerCase().replace(/\s+/g, '').split('+').filter(Boolean);
  if (!parts.length || parts.length > 4) return null;
  const vks = parts.map((p) => VK[p]);
  if (vks.some((v) => v == null)) return null;
  if (vks.length === 1 && vks[0] === VK.win) return null;
  return vks;
}

// The element the model meant: by id, by text (with "near"), else null.
function findElement(args, elements) {
  const els = elements || [];
  if (args.id != null) return els.find((e) => Number(e.id) === Number(args.id)) || null;
  const text = String(args.text || '').trim();
  if (!text) return null;
  let named = els.filter((e) => overlap(text, e.name) >= 0.5);
  // "Recipients" for Gmail's "To recipients" box (live 2026-10-12): a whole-word
  // match inside a longer name counts when it is the only one.
  if (!named.length) {
    const re = new RegExp('(?:^|[^a-z0-9])' + text.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9])', 'i');
    const loose = els.filter((e) => re.test(String(e.name || '')));
    if (loose.length === 1 || (loose.length > 1 && args.near)) named = loose;
  }
  if (!named.length) return null;
  if (named.length === 1 || !args.near) return named[0];
  // Several rows carry the label: take the one closest to the "near" item.
  const anchor = els.find((e) => overlap(String(args.near), e.name) >= 0.5);
  if (!anchor) return named[0];
  const ac = centre(anchor.rect);
  return named.slice().sort((a, b) => Math.hypot(centre(a.rect).x - ac.x, centre(a.rect).y - ac.y) - Math.hypot(centre(b.rect).x - ac.x, centre(b.rect).y - ac.y))[0];
}

function fractionToPhys(args, cap, originPhys) {
  if (args.x == null || args.y == null || args.x === '' || args.y === '' || !originPhys || !cap || !Number.isFinite(cap.pxWidth) || !Number.isFinite(cap.pxHeight) || cap.pxWidth < 1 || cap.pxHeight < 1) return null;
  const x = Number(args.x), y = Number(args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1 || y > 1 || !cap) return null;
  return { x: Math.round(originPhys.x + x * (cap.pxWidth - 1)), y: Math.round(originPhys.y + y * (cap.pxHeight - 1)) };
}

// Where keys went, from the sidecar's answer: 'into "Text editor" in "Untitled - Notepad"'.
function landed(r) {
  if (!r) return '';
  const field = r.focus ? '"' + clip(r.focus, 40) + '"' : r.focusType ? 'the ' + clip(r.focusType, 30) : '';
  const win = r.window ? '"' + clip(r.window, 60) + '"' : '';
  if (!field && !win) return '';
  return (field ? ' into ' + field : '') + (win ? ' in ' + win : '') + (field ? '' : ', with no field focused');
}

// The browsers Hands can hand an address to directly, by the name the user
// or the app list uses. exe is what `start` resolves through App Paths.
const BROWSERS = [
  { key: 'chrome', label: 'Chrome', exe: 'chrome.exe', process: 'chrome', match: /\bchrome\b/i },
  { key: 'firefox', label: 'Firefox', exe: 'firefox.exe', process: 'firefox', match: /\bfirefox\b/i },
  { key: 'edge', label: 'Edge', exe: 'msedge.exe', process: 'msedge', match: /\b(?:ms)?edge\b/i },
  { key: 'brave', label: 'Brave', exe: 'brave.exe', process: 'brave', match: /\bbrave\b/i },
  { key: 'opera', label: 'Opera', exe: 'opera.exe', process: 'opera', match: /\bopera\b/i },
];
function browserFor(name) { const s = String(name || ''); return s ? BROWSERS.find((b) => b.match.test(s)) || null : null; }

// Does the front window belong to this app? The process name and the title
// are both tried, loosely ("Google Chrome" / chrome, "Word" / WINWORD).
function frontIs(fg, app) {
  if (!fg || !app) return false;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = norm(app.name);
  const proc = norm(fg.process);
  const title = norm(fg.title);
  // A browser the task uses: by process; any browser when the default one is unknown.
  if (app.process && proc === norm(app.process)) return true;
  if (app.anyBrowser && BROWSERS.some((b) => proc === b.process)) return true;
  if (!want) return false;
  if (proc && (proc.includes(want) || want.includes(proc)) && proc.length >= 3) return true;
  const words = String(app.name).toLowerCase().split(/\s+/).filter((w) => w.length >= 3 && !['google', 'microsoft', 'the', 'app'].includes(w));
  if (words.some((w) => proc.includes(norm(w)))) return true;
  if (title && title.endsWith(want)) return true;
  if (words.length && words.every((w) => title.includes(norm(w)))) return true;
  const known = { word: 'winword', excel: 'excel', powerpoint: 'powerpnt', outlook: 'outlook', onenote: 'onenote', chrome: 'chrome', edge: 'msedge', 'file explorer': 'explorer', terminal: 'windowsterminal', 'visual studio code': 'code', 'vs code': 'code' };
  const k = known[String(app.name).toLowerCase()];
  return Boolean(k && proc === k);
}

const APP_FRONT_MS = 8000;       // a cold start of Word, Excel or a browser

function createActions({ probe, hands, shell, pointAt, settleThread, launchApp, launchBrowser, defaultBrowser, apps, searchFiles, openPath, refuseSite, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), selfPid = -1 }) {
  const say = log;
  // Keys only ever go to the app the task opened (ctx.target). Live 2026-10-12:
  // a browser stayed behind a full-screen window, the next look landed on the
  // chat app that came to the front, and an email body was pasted into it.
  function wrongWindow(ctx) {
    if (!ctx || !ctx.target) return null;
    if (!ctx.fg) return 'no window is in front';
    if (frontIs(ctx.fg, ctx.target)) return null;
    return '"' + clip(ctx.fg.title || ctx.fg.process, 50) + '" is in front, not ' + ctx.target.name + '; nothing typed. Bring ' + ctx.target.name + ' to the front first (open_app), then type';
  }
  // The control with keyboard focus, read-only (name, type, rect, isPassword).
  async function focusedField() {
    if (!probe) return null;
    try { const r = await probe.request('uia.focused', { ignorePid: selfPid }, 900); return r && r.element ? r.element : null; } catch (_) { return null; }
  }
  // The Knot flies to every target, including a window that just came up.
  async function pointWindow(fg, label) {
    if (!pointAt || !fg || !fg.rect) return;
    try { pointAt(fg.rect, { instruction: label }); await sleep(settleThread || 250); } catch (_) { /* courtesy */ }
  }
  // After a web address: the browser that should now hold it.
  async function browserTarget(named) {
    if (named) return { name: named.label, process: named.process };
    let d = null;
    try { d = typeof defaultBrowser === 'function' ? await defaultBrowser() : null; } catch (_) { d = null; }
    return d ? { name: d.label, process: d.process } : { name: 'the browser', anyBrowser: true };
  }
  // Poll the front window until it belongs to the app, up to ms. -> fg or null.
  async function awaitFront(app, ms, ctx) {
    if (!probe) return null;
    const t0 = Date.now();
    let fg = null, nudgedAt = 0;
    while (Date.now() - t0 < ms) {
      try { const r = await probe.request('fg', { ignorePid: selfPid }, 1500); fg = r && r.hwnd ? r : null; } catch (_) { fg = null; }
      if (frontIs(fg, app)) { await sleep(250); return fg; }
      // Started minimized or behind: after a second, bring it forward by name
      // (the sidecar restores a minimized window and takes the foreground).
      if (Date.now() - t0 > 1000 && Date.now() - nudgedAt > 1500) {
        nudgedAt = Date.now();
        try { await hands.request('win.activate', { name: app.name }, 2000); } catch (_) { /* keep waiting */ }
      }
      await sleep(200);
    }
    return null;
  }
  // Keys carry the window Hands last read and our own pid: the sidecar puts
  // that window back in front if the Companion has taken it, and never types
  // into the Companion itself.
  const keyTarget = (ctx) => ({ hwnd: ctx && ctx.fg && ctx.fg.hwnd ? ctx.fg.hwnd : undefined, selfPid: selfPid > 0 ? selfPid : undefined });

  // The point to act on, from an element (its centre) or a fraction of the screen.
  async function resolvePoint(args, ctx) {
    const el = findElement(args, ctx.elements);
    if (el && el.rect) return { point: centre(el.rect), rect: el.rect, name: el.name || '', type: el.type || '', element: el };
    const p = fractionToPhys(args, ctx.cap, ctx.originPhys);
    if (!p) return null;
    // A point on the screenshot: ask Windows what sits there, so the report (and the card) can name it.
    let under = null;
    if (probe) { try { const r = await probe.request('uia.frompoint', { x: p.x, y: p.y, ignorePid: selfPid }, 1200); under = r && r.element; } catch (_) { under = null; } }
    return { point: p, rect: under && under.rect ? under.rect : { x: p.x - 4, y: p.y - 4, w: 8, h: 8 }, name: under ? under.name || '' : '', type: under ? under.type || '' : '', element: under };
  }

  const actions = {
    async move_mouse(args, ctx) {
      const t = await resolvePoint(args, ctx);
      if (!t) return { ok: false, report: 'could not find that mouse target' };
      const ms = Number.isFinite(Number(args.duration_ms)) && args.duration_ms != null ? Math.max(0, Math.min(1000, Math.round(Number(args.duration_ms)))) : 250;
      const r = await hands.request('mouse.move', { x: t.point.x, y: t.point.y, durationMs: ms }, 3000);
      if (!r || !r.ok) return { ok: false, report: 'the pointer could not be moved' };
      return { ok: true, report: 'moved the pointer' + (t.name ? ' to "' + clip(t.name, 60) + '"' : ' to that spot') + '; check for any hover menu', lookAfter: 40, settle: 350, giveUp: 180 };
    },

    async window_minimize(args, ctx) { return windowShow('minimize', ctx); },
    async window_maximize(args, ctx) { return windowShow('maximize', ctx); },
    async window_close(args, ctx) {
      if (!ctx.fg || !ctx.fg.hwnd) return { ok: false, report: 'no target window to close' };
      return actions.press({ keys: 'alt+f4' }, ctx);
    },

    async read_window(args, ctx) {
      if (!probe || !ctx.fg || !ctx.fg.hwnd) return { ok: false, report: 'no readable front window' };
      const r = await probe.request('uia.text', { hwnd: ctx.fg.hwnd, ignorePid: selfPid, max: 20000, budgetMs: 2500 }, 6000);
      const content = String(r && r.text || '').replace(/\u0000/g, '').trim();
      if (!content) return { ok: false, report: 'the window exposed no text; use the screenshot or try another view' };
      return { ok: true, report: 'read ' + content.length + ' characters from the front window', content: content.slice(0, 12000), noLook: true };
    },

    async click(args, ctx) {
      const t = await resolvePoint(args, ctx);
      // Live 2026-10-22: a YouTube result was asked for by text four times in a
      // row (the page listed 20 controls, none of them the video) before the
      // model tried x,y. The report now says what to do instead.
      if (!t) {
        const n = (ctx.elements || []).length;
        const asked = args.text ? 'a control called "' + clip(String(args.text), 50) + '"' : args.id != null ? 'control ' + args.id : 'that control';
        return { ok: false, report: 'could not find ' + asked + ' among the ' + n + ' listed; this app lists few of its controls, so do not ask for it by text again: click by x and y from the screenshot instead' };
      }
      if (sensitiveTarget(t.element) || sensitiveTarget({ name: t.name, type: t.type || 'edit' })) return { ok: false, refused: 'password', report: 'that is a private field; the user fills it in' };
      if (pointAt) { try { pointAt(t.rect, { instruction: 'Clicking ' + (t.name ? '"' + clip(t.name, 40) + '"' : 'here') }); await sleep(settleThread || 250); } catch (_) { /* the thread is a courtesy */ } }
      const r = await hands.request('mouse.click', { x: t.point.x, y: t.point.y, button: args.button === 'right' ? 'right' : args.button === 'middle' ? 'middle' : 'left', double: Boolean(args.double) }, 4000);
      if (r && r.refused) return { ok: false, refused: r.refused, report: 'that field is private; not clicked' };
      if (!r || !r.ok) return { ok: false, report: 'the click did not go through' + (r && r.error ? ': ' + r.error : '') };
      // Settle caps trimmed 2026-10-29: in the ledger a Hands step spent about
      // 1.4 s outside the model, most of it waiting on screens that had already
      // settled (click 2500/1000, keys 2000/900, page 3000/1500 before).
      return { ok: true, report: 'clicked ' + (t.name ? '"' + clip(t.name, 60) + '"' : 'at that spot'), target: t, lookAfter: 40, settle: 1500, giveUp: 600 };
    },

    async type(args, ctx) {
      const text = String(args.text || '');
      if (!text) return { ok: false, report: 'nothing to type' };
      const wrong = wrongWindow(ctx);
      if (wrong) return { ok: false, refused: 'window', report: wrong };
      let target = null;
      if (args.id != null || args.text_target) {
        target = await resolvePoint({ id: args.id, text: args.text_target }, ctx);
        if (!target) return { ok: false, report: 'could not find that field; take a look' };
        if (sensitiveTarget(target.element) || sensitiveTarget({ name: target.name, type: 'edit' })) return { ok: false, refused: 'password', report: 'that is a private field; the user fills it in' };
        // A tab label, a button or a menu item is never where text goes (live
        // 2026-10-12: a retry typed the list into Notepad's tab header).
        if (NOT_A_FIELD.test(target.type || '')) return { ok: false, report: '"' + clip(target.name || target.type, 40) + '" is a ' + String(target.type).toLowerCase() + ', not a text field; type into the editor or the box itself, or just type with no id when it already has focus' };
        if (pointAt) { try { pointAt(target.rect, { instruction: 'Typing into ' + (target.name ? '"' + clip(target.name, 40) + '"' : 'this box') }); await sleep(settleThread || 250); } catch (_) { /* courtesy */ } }
        const c = await hands.request('mouse.click', { x: target.point.x, y: target.point.y, button: 'left' }, 4000);
        if (c && c.refused) return { ok: false, refused: c.refused, report: 'that field is private; not typed' };
        if (!c || !c.ok) return { ok: false, report: 'could not focus the requested field; nothing typed' };
        await sleep(150);
        if (!args.append) { const selected = await hands.request('keys.press', Object.assign({ keys: [VK.ctrl, VK.a] }, keyTarget(ctx)), 2000); if (!selected || !selected.ok) return { ok: false, report: 'could not select the existing text; nothing typed' }; await sleep(40); }
      }
      if (!target) {
        // Typing into whatever has focus: the Knot still flies to that field,
        // and a private field is refused before any key is sent.
        const f = await focusedField();
        if (f && f.isPassword) return { ok: false, refused: 'password', report: 'the focused field is private; the user fills it in' };
        if (f && f.rect && pointAt) { try { pointAt(f.rect, { instruction: 'Typing into ' + (f.name ? '"' + clip(f.name, 40) + '"' : 'this box') }); await sleep(settleThread || 250); } catch (_) { /* courtesy */ } }
      }
      const r = await hands.request('keys.text', Object.assign({ text: text.slice(0, MAX_TEXT), enter: Boolean(args.submit) }, keyTarget(ctx)), 9000);
      if (r && r.refused) return { ok: false, refused: r.refused, report: 'the focused field is private; nothing typed' };
      if (!r || !r.ok) return { ok: false, report: 'typing did not go through' + (r && r.error ? ': ' + r.error : '') };
      // The sidecar checks the field's own text after the paste (live
      // 2026-10-13: a YouTube search box got an empty paste and Enter searched
      // for nothing). verified true: it is there. false: it is not, and Enter
      // was held back. null: the field cannot be read; look before trusting it.
      const where = landed(r) || (target && target.name ? ' into "' + clip(target.name, 40) + '"' : '');
      const check = r.verified === true ? '; the box shows it' : r.verified === false ? '; but the box does not show it' + (args.submit ? ', so Enter was not pressed' : '') + ': look, then try another way' : '; could not read the box back, check the screen before saying done';
      const unverified = r.verified !== true;
      return { ok: true, report: 'typed ' + Math.min(text.length, MAX_TEXT) + ' characters' + where + (args.submit && r.submitted !== false ? ' and pressed Enter' : '') + check, target, unverified, lookAfter: 300, settle: args.submit ? 2000 : 1000, giveUp: args.submit ? 600 : 400 };
    },

    async press(args, ctx) {
      const vks = parseKeys(args.keys);
      if (!vks) return { ok: false, report: 'unknown key "' + clip(args.keys, 30) + '"' };
      const wrong = wrongWindow(ctx);
      if (wrong) return { ok: false, refused: 'window', report: wrong };
      { const f = await focusedField(); if (f && f.rect && pointAt) { try { pointAt(f.rect, { instruction: 'Pressing ' + clip(args.keys, 20) }); await sleep(settleThread || 250); } catch (_) { /* courtesy */ } } }
      const r = await hands.request('keys.press', Object.assign({ keys: vks }, keyTarget(ctx)), 3000);
      if (!r || !r.ok) return { ok: false, report: 'that key did not go through' + (r && r.error ? ': ' + r.error : '') };
      return { ok: true, report: 'pressed ' + clip(args.keys, 30) + (r.window ? ' in "' + clip(r.window, 60) + '"' : ''), lookAfter: 40, settle: 600, giveUp: 300 };
    },

    async scroll(args, ctx) {
      const pages = Math.max(1, Math.min(MAX_PAGES, Number(args.amount) || 1));
      const dir = String(args.direction || 'down').toLowerCase();
      let at = null;
      if (args.id != null || args.text) { const t = await resolvePoint(args, ctx); if (t) at = t.point; }
      if (!at && Number.isFinite(Number(args.x))) at = fractionToPhys(args, ctx.cap, ctx.originPhys);
      if (!at && ctx.fg && ctx.fg.rect) at = centre(ctx.fg.rect);
      if (!at) return { ok: false, report: 'nowhere to scroll' };
      const ticks = pages * PAGE_TICKS;
      const dy = dir === 'down' ? -ticks : dir === 'up' ? ticks : 0;
      const dx = dir === 'right' ? -ticks : dir === 'left' ? ticks : 0;
      const r = await hands.request('mouse.scroll', { x: at.x, y: at.y, dy, dx }, 3000);
      if (!r || !r.ok) return { ok: false, report: 'the scroll did not go through' };
      return { ok: true, report: 'scrolled ' + dir + ' ' + pages + (pages === 1 ? ' page' : ' pages'), lookAfter: 50, settle: 500 };
    },

    async drag(args, ctx) {
      const from = await resolvePoint({ id: args.from_id, text: args.from_text, x: args.from_x, y: args.from_y }, ctx);
      const to = await resolvePoint({ id: args.to_id, text: args.to_text, x: args.to_x, y: args.to_y }, ctx);
      if (!from || !to) return { ok: false, report: 'could not find both ends of the drag' };
      if (pointAt) { try { pointAt(to.rect, { instruction: 'Dragging to ' + (to.name ? '"' + clip(to.name, 40) + '"' : 'here') }); await sleep(settleThread || 250); } catch (_) { /* courtesy */ } }
      const r = await hands.request('mouse.drag', { x0: from.point.x, y0: from.point.y, x1: to.point.x, y1: to.point.y }, 6000);
      if (!r || !r.ok) return { ok: false, report: 'the drag did not go through' };
      return { ok: true, report: 'dragged ' + (from.name ? '"' + clip(from.name, 30) + '"' : 'it') + ' to ' + (to.name ? '"' + clip(to.name, 30) + '"' : 'the spot'), toName: to.name, lookAfter: 60, settle: 800 };
    },

    async open_app(args, ctx) {
      const name = String(args.name || '').trim();
      if (!name) return { ok: false, report: 'which app?' };
      { const line = refuseSite && refuseSite(name); if (line) return { ok: false, guarded: true, report: line }; }
      const list = typeof apps === 'function' ? apps() : apps || [];
      const hit = list.find((a) => a.name.toLowerCase() === name.toLowerCase()) || list.find((a) => overlap(name, a.describe || a.name) >= 0.5) || list.find((a) => a.name.toLowerCase().includes(name.toLowerCase()));
      if (!hit) return { ok: false, report: 'no app called "' + clip(name, 40) + '" on this computer' };
      const browser = browserFor(hit.name);
      if (browser) ctx.browser = browser;
      // Already running: bring it to the front instead of launching a second copy.
      let how = 'opened';
      let activated = false;
      try { const a = await hands.request('win.activate', { name: hit.name }, 3000); if (a && a.ok) { activated = true; how = 'brought to the front'; } } catch (_) { /* launch instead */ }
      if (!activated) { try { launchApp(hit.appId); } catch (e) { return { ok: false, report: 'could not start ' + hit.name + ': ' + clip(e.message, 80) }; } }
      // Opened is not the same as in front. An app that is still starting (Word
      // takes seconds to its start screen) is not ready for keys, so wait until
      // its window is in front and make it the window the next keys go to.
      const fg = await awaitFront(hit, activated ? 2500 : APP_FRONT_MS, ctx);
      ctx.target = { name: hit.name };
      if (fg) { ctx.fg = fg; await pointWindow(fg, hit.name); return { ok: true, report: hit.name + ' is in front' + (fg.title ? ' ("' + clip(fg.title, 50) + '")' : ''), lookAfter: 50, settle: activated ? 350 : 800, giveUp: 300 }; }
      return { ok: true, report: how + ' ' + hit.name + ', but its window is not in front yet; take a look before typing into it', lookAfter: 100, settle: 1200, giveUp: 600 };
    },

    async open_url(args, ctx) {
      let url = String(args.url || '').trim();
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
      try { const u = new URL(url); if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) throw new Error('not a web address'); url = u.toString(); } catch (_) { return { ok: false, report: 'that is not a web address' }; }
      // The focus guard is on and this is what it keeps the person off (live
      // 2026-11-03: Hands reopened what the guard closed, in a second browser).
      { const line = refuseSite && refuseSite(url); if (line) return { ok: false, guarded: true, report: line }; }
      // A browser the user named, or one Hands opened in this task, gets the
      // address; otherwise the default browser (live 2026-10-11: "open Chrome
      // and search YouTube" opened Chrome and then YouTube in Firefox).
      const browser = browserFor(args.in || args.browser) || ctx.browser || null;
      let named = null, where = 'the default browser';
      if (browser && typeof launchBrowser === 'function') {
        try { await launchBrowser(browser, url); named = browser; where = browser.label; }
        catch (e) { log('[hands] ' + browser.label + ' launch failed, default browser instead: ' + e.message); }
      }
      if (!named) await shell.openExternal(url);
      // Opened is not in front: wait for the browser window, and make it the
      // only window the next keys may go to.
      const target = await browserTarget(named);
      ctx.target = target;
      const fg = await awaitFront(target, APP_FRONT_MS, ctx);
      if (fg) { ctx.fg = fg; await pointWindow(fg, target.name); return { ok: true, report: 'opened ' + clip(url, 80) + ' in ' + where + '; ' + (fg.title ? '"' + clip(fg.title, 50) + '" is in front' : 'it is in front'), lookAfter: 100, settle: 1000, giveUp: 450 }; }
      return { ok: true, report: 'opened ' + clip(url, 80) + ' in ' + where + ', but the browser window is not in front; do not type yet: take a look, or open_app the browser', lookAfter: 100, settle: 1200, giveUp: 600 };
    },

    async web_search(args, ctx) {
      const q = String(args.query || '').trim();
      if (!q) return { ok: false, report: 'search for what?' };
      return actions.open_url({ url: 'https://www.google.com/search?q=' + encodeURIComponent(q), in: args.in }, ctx).then((r) => Object.assign(r, { report: r.ok ? 'searched the web for "' + clip(q, 60) + '"; ' + r.report.replace(/^opened [^;]*;\s*/, '') : r.report }));
    },

    async find_files(args, ctx) {
      const q = cleanFileQuery(args.query);
      if (!q) return { ok: false, report: 'find what?' };
      const hits = await searchFiles(q, { kind: args.kind ? String(args.kind) : null, max: 8 });
      ctx.files = hits;
      if (!hits.length) return { ok: true, report: 'no files match "' + clip(q, 50) + '" in ' + HOME_FOLDERS.join(', ') };
      return { ok: true, report: 'found ' + hits.length + ': ' + hits.map((h, i) => (i + 1) + '. ' + h.name + ' (' + h.folder + ', ' + h.when + ')').join('; '), noLook: true };
    },

    async open_file(args, ctx) {
      const i = Number(args.index) - 1;
      const hit = ctx.files && ctx.files[i];
      if (!hit) return { ok: false, report: 'no file number ' + args.index + ' in the last search' };
      const err = await openPath(hit.path);
      if (err) return { ok: false, report: 'could not open it: ' + clip(err, 80) };
      return { ok: true, report: 'opened ' + hit.name, lookAfter: 150, settle: 1500 };
    },

    async wait(args) {
      const s = Math.max(0, Math.min(MAX_WAIT_S, Number(args.seconds) || 1));
      await sleep(s * 1000);
      return { ok: true, report: 'waited ' + s + ' s', lookAfter: 0, settle: 500 };
    },

    async look() { return { ok: true, report: 'took a fresh look', lookAfter: 0, settle: 0 }; },

    async run_command(args) {
      const cmd = String(args.command || '').trim();
      if (!cmd) return { ok: false, report: 'no command specified' };
      const { exec } = require('child_process');
      const timeoutMs = Math.max(1000, Math.min(30000, Number(args.timeout_ms) || 15000));
      return new Promise((resolve) => {
        exec(cmd, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
          const out = String(stdout || '').trim();
          const errout = String(stderr || '').trim();
          if (err) {
            return resolve({
              ok: false,
              report: 'command exited with error: ' + clip(err.message, 120) + (errout ? ' - ' + clip(errout, 200) : ''),
              content: (out + '\n' + errout).trim().slice(0, 10000),
              noLook: true
            });
          }
          return resolve({
            ok: true,
            report: 'command executed successfully' + (out ? ': ' + clip(out, 100) : ''),
            content: (out || errout || 'ok').slice(0, 10000),
            noLook: true
          });
        });
      });
    },

    async get_clipboard() {
      try {
        const { clipboard } = require('electron');
        const text = clipboard.readText();
        return { ok: true, report: 'read ' + text.length + ' characters from clipboard', content: text.slice(0, 10000), noLook: true };
      } catch (e) {
        return { ok: false, report: 'could not read clipboard: ' + clip(e.message, 80) };
      }
    },

    async set_clipboard(args) {
      try {
        const text = String(args.text || '');
        const { clipboard } = require('electron');
        if (args.restoreAfterMs && Number(args.restoreAfterMs) > 0) {
          const prev = clipboard.readText();
          clipboard.writeText(text);
          setTimeout(() => {
            try { clipboard.writeText(prev); } catch (_) {}
          }, Number(args.restoreAfterMs));
          return { ok: true, report: 'copied ' + text.length + ' characters to clipboard (will restore in ' + args.restoreAfterMs + 'ms)', noLook: true };
        }
        clipboard.writeText(text);
        return { ok: true, report: 'copied ' + text.length + ' characters to clipboard', noLook: true };
      } catch (e) {
        return { ok: false, report: 'could not write clipboard: ' + clip(e.message, 80) };
      }
    },

    async release_modifiers() {
      try {
        await hands.request('keys.release_modifiers', {}, 1000);
        return { ok: true, report: 'released modifier keys', noLook: true };
      } catch (_) {
        return { ok: false, report: 'could not release modifier keys', noLook: true };
      }
    },

    async paste_text(args, ctx) {
      try {
        const text = String(args.text || '');
        if (!text) return { ok: false, report: 'nothing to paste' };
        const { clipboard } = require('electron');
        const prev = clipboard.readText();
        clipboard.writeText(text);
        const r = await hands.request('keys.press', Object.assign({ keys: [VK.ctrl, VK.v] }, keyTarget(ctx)), 2000);
        setTimeout(() => {
          try { clipboard.writeText(prev); } catch (_) {}
        }, 300);
        const ok = !!(r && r.ok);
        return { ok, report: ok ? 'pasted ' + text.length + ' characters (clipboard preserved)' : 'could not paste into target window', lookAfter: 200, settle: 800 };
      } catch (e) {
        return { ok: false, report: 'could not paste text: ' + clip(e.message, 80) };
      }
    },

    async switch_window(args, ctx) {
      const name = String(args.name || '').trim();
      if (!name) return { ok: false, report: 'which window?' };
      try {
        const a = await hands.request('win.activate', { name }, 3000);
        if (a && a.ok) {
          if (ctx) ctx.target = { name };
          return { ok: true, report: 'switched to window "' + clip(name, 50) + '"', lookAfter: 200, settle: 1000 };
        }
      } catch (_) {}
      return { ok: false, report: 'could not find or switch to window "' + clip(name, 50) + '"' };
    },

    async read_file(args) {
      const fs = require('fs');
      const p = String(args.path || '').trim();
      if (!p) return { ok: false, report: 'no path specified' };
      try {
        if (!fs.existsSync(p)) return { ok: false, report: 'file not found: ' + clip(p, 80) };
        const stat = fs.statSync(p);
        if (stat.isDirectory()) return { ok: false, report: clip(p, 80) + ' is a directory; use list_directory instead' };
        const content = fs.readFileSync(p, 'utf8');
        return { ok: true, report: 'read ' + content.length + ' characters from ' + path.basename(p), content: content.slice(0, 20000), noLook: true };
      } catch (e) {
        return { ok: false, report: 'failed to read file: ' + clip(e.message, 100) };
      }
    },

    async write_file(args) {
      const fs = require('fs');
      const p = String(args.path || '').trim();
      if (!p) return { ok: false, report: 'no path specified' };
      const content = String(args.content != null ? args.content : '');
      const append = Boolean(args.append);
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        if (append) {
          fs.appendFileSync(p, content, 'utf8');
        } else {
          fs.writeFileSync(p, content, 'utf8');
        }
        return { ok: true, report: (append ? 'appended to ' : 'wrote ') + path.basename(p) + ' (' + content.length + ' characters)', noLook: true };
      } catch (e) {
        return { ok: false, report: 'failed to write file: ' + clip(e.message, 100) };
      }
    },

    async list_directory(args) {
      const fs = require('fs');
      const p = String(args.path || '.').trim();
      try {
        if (!fs.existsSync(p)) return { ok: false, report: 'directory not found: ' + clip(p, 80) };
        const entries = fs.readdirSync(p, { withFileTypes: true });
        const list = entries.slice(0, 50).map(e => (e.isDirectory() ? '[DIR] ' : '') + e.name);
        return { ok: true, report: 'found ' + entries.length + ' items in ' + (path.basename(p) || p), content: list.join('\n'), noLook: true };
      } catch (e) {
        return { ok: false, report: 'failed to list directory: ' + clip(e.message, 100) };
      }
    },

    async http_request(args) {
      let url = String(args.url || '').trim();
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      const method = String(args.method || 'GET').toUpperCase();
      try {
        const fetchOpts = { method, headers: Object.assign({}, args.headers || {}) };
        if (args.body && method !== 'GET') {
          fetchOpts.body = typeof args.body === 'object' ? JSON.stringify(args.body) : String(args.body);
          if (!fetchOpts.headers['Content-Type']) fetchOpts.headers['Content-Type'] = 'application/json';
        }
        const res = await fetch(url, fetchOpts);
        const text = await res.text();
        return { ok: res.ok, report: 'HTTP ' + res.status + ' from ' + clip(url, 60) + ' (' + text.length + ' chars)', content: text.slice(0, 15000), noLook: true };
      } catch (e) {
        return { ok: false, report: 'HTTP request failed: ' + clip(e.message, 100) };
      }
    },

    async get_system_info() {
      const os = require('os');
      const totalMemGb = (os.totalmem() / 1e9).toFixed(1);
      const freeMemGb = (os.freemem() / 1e9).toFixed(1);
      const cpus = os.cpus();
      const cpuModel = cpus && cpus.length ? cpus[0].model : 'CPU';
      const info = {
        platform: os.platform(),
        release: os.release(),
        cpu: cpuModel + ' (' + (cpus ? cpus.length : 0) + ' cores)',
        memory: freeMemGb + ' GB free of ' + totalMemGb + ' GB',
        uptime_hours: (os.uptime() / 3600).toFixed(1),
        user: os.userInfo ? os.userInfo().username : 'user',
      };
      return { ok: true, report: 'System: ' + info.cpu + ', ' + info.memory, content: JSON.stringify(info, null, 2), noLook: true };
    },

    async list_processes() {
      const { exec } = require('child_process');
      return new Promise((resolve) => {
        exec('tasklist /FO CSV /NH', { windowsHide: true }, (err, stdout) => {
          if (err) return resolve({ ok: false, report: 'could not list processes: ' + clip(err.message, 100) });
          const lines = String(stdout || '').split('\n').filter(Boolean);
          const procs = lines.slice(0, 40).map(l => {
            const parts = l.split('","').map(s => s.replace(/^"|"$/g, ''));
            return parts[0] + ' (PID: ' + parts[1] + ', Mem: ' + (parts[4] || '') + ')';
          });
          return resolve({ ok: true, report: 'retrieved ' + lines.length + ' running processes', content: procs.join('\n'), noLook: true });
        });
      });
    },

    async kill_process(args) {
      const target = String(args.name || args.pid || '').trim();
      if (!target) return { ok: false, report: 'no process name or PID specified' };
      const { exec } = require('child_process');
      const cmd = /^\d+$/.test(target) ? 'taskkill /F /PID ' + target : 'taskkill /F /IM "' + target + (target.endsWith('.exe') ? '' : '.exe') + '"';
      return new Promise((resolve) => {
        exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
          if (err) return resolve({ ok: false, report: 'failed to kill ' + target + ': ' + clip(stderr || err.message, 100) });
          return resolve({ ok: true, report: 'terminated ' + target, noLook: true });
        });
      });
    },

    async show_notification(args) {
      try {
        const { Notification } = require('electron');
        if (Notification && Notification.isSupported && Notification.isSupported()) {
          const n = new Notification({
            title: String(args.title || 'Rax'),
            body: String(args.body || ''),
          });
          n.show();
          return { ok: true, report: 'displayed desktop notification', noLook: true };
        }
      } catch (_) {}
      return { ok: true, report: 'notification sent: ' + clip(args.title || args.body || '', 60), noLook: true };
    },
  };

  async function windowShow(mode, ctx) {
    if (!ctx.fg || !ctx.fg.hwnd) return { ok: false, report: 'no target window' };
    const r = await hands.request('win.show', { hwnd: ctx.fg.hwnd, selfPid: selfPid > 0 ? selfPid : undefined, mode }, 3000);
    if (!r || !r.ok) return { ok: false, report: 'could not ' + mode + ' the window' + (r && r.error ? ': ' + r.error : '') };
    return { ok: true, report: mode + 'd the window', noLook: true };
  }

  async function run(name, args, ctx) {
    const fn = actions[name];
    if (!fn) return { ok: false, report: 'no such action "' + clip(name, 30) + '"' };
    try { return await fn(args || {}, ctx || {}); }
    catch (e) { say('[hands] ' + name + ' failed: ' + e.message); return { ok: false, report: name + ' failed: ' + clip(e.message, 100) }; }
  }

  return { run, names: Object.keys(actions), findElement, resolvePoint, parseKeys };
}

// Windows search over the home folders, by name, newest first. PowerShell is
// the one tool every Windows has. The command text is a constant; every value
// (the query the model wrote, the roots, the include list, the cap) rides in
// the environment and is read back as $env:..., never joined into the script.
// Security audit 2026-11-01: with -Command, extra argv elements are more
// command text, so the old "passed as an argument" promise did not hold.
const FILE_SEARCH_SCRIPT = '$q=[System.Management.Automation.WildcardPattern]::Escape($env:NUS_FS_QUERY); $roots=$env:NUS_FS_ROOTS -split ";"; $inc=$env:NUS_FS_INC -split ","; $max=[int]$env:NUS_FS_MAX; ' +
  'Get-ChildItem -LiteralPath $roots -Recurse -File -Include $inc -ErrorAction SilentlyContinue -Depth 4 | Where-Object { $_.Name -like ("*" + $q + "*") } | Sort-Object LastWriteTime -Descending | Select-Object -First $max | ForEach-Object { $_.FullName + "|" + $_.LastWriteTime.ToString("yyyy-MM-dd") }';
const FILE_SEARCH_MAX_QUERY = 120;
// Control characters out, length capped; empty after that means no search.
function cleanFileQuery(query) { return String(query || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, FILE_SEARCH_MAX_QUERY); }
function createFileSearch({ homedir, execFile, env = process.env }) {
  return async function searchFiles(query, { kind, max = 8 } = {}) {
    const q = cleanFileQuery(query);
    if (!q) return [];
    const roots = HOME_FOLDERS.map((f) => path.join(homedir, f));
    const ext = { pdf: '*.pdf', image: '*.png,*.jpg,*.jpeg,*.gif,*.webp', document: '*.doc,*.docx,*.txt,*.md,*.rtf,*.odt', video: '*.mp4,*.mov,*.mkv,*.webm', audio: '*.mp3,*.wav,*.m4a', archive: '*.zip,*.7z,*.rar', spreadsheet: '*.xlsx,*.xls,*.csv', slides: '*.pptx,*.ppt' }[String(kind || '').toLowerCase()] || '*';
    const cap = Math.max(1, Math.min(50, Number(max) || 8));
    const childEnv = Object.assign({}, env, { NUS_FS_QUERY: q, NUS_FS_ROOTS: roots.join(';'), NUS_FS_INC: ext, NUS_FS_MAX: String(cap) });
    // Only paths inside one of the roots are ever reported, whatever PowerShell printed.
    const inside = (p) => roots.some((r) => { const rel = path.relative(r, p); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); });
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', FILE_SEARCH_SCRIPT], { windowsHide: true, timeout: 20000, encoding: 'utf8', env: childEnv }, (e, out) => {
        if (e && !out) { resolve([]); return; }
        resolve(String(out || '').split(/\r?\n/).filter(Boolean).map((line) => { const i = line.lastIndexOf('|'); const full = line.slice(0, i); return { path: full, name: path.basename(full), folder: path.basename(path.dirname(full)), when: line.slice(i + 1) }; }).filter((h) => h.path && inside(h.path)).slice(0, cap));
      });
    });
  };
}

// Start a browser with an address: the exe is found through its registered
// App Path and started directly with the URL as one argument. Never through
// cmd: live 2026-10-12 a Gmail compose address lost everything after its
// first "&" ("'fs' is not recognized as a command"), so To and Subject never
// arrived. Rejects if the browser is not installed.
function createBrowserLaunch({ execFile, spawn }) {
  const paths = new Map();
  function appPath(exe) {
    if (paths.has(exe)) return Promise.resolve(paths.get(exe));
    const hives = ['HKCU', 'HKLM'];
    const tryHive = (i) => new Promise((resolve) => {
      if (i >= hives.length) { resolve(null); return; }
      execFile('reg.exe', ['query', hives[i] + '\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + exe, '/ve'], { windowsHide: true, timeout: 4000, encoding: 'utf8' }, (e, out) => {
        const m = /REG_SZ\s+(.+?)\s*$/m.exec(String(out || ''));
        const p = m ? m[1].trim().replace(/^"|"$/g, '') : '';
        if (p) resolve(p); else tryHive(i + 1).then(resolve);
      });
    });
    return tryHive(0).then((p) => { paths.set(exe, p); return p; });
  }
  return async function launchBrowser(browser, url) {
    const exe = await appPath(browser.exe);
    if (!exe) throw new Error(browser.label + ' is not installed');
    return new Promise((resolve, reject) => {
      let child;
      try { child = (spawn || require('child_process').spawn)(exe, [url], { detached: true, stdio: 'ignore', windowsHide: true }); }
      catch (e) { reject(new Error(String(e.message || e).slice(0, 120))); return; }
      child.on('error', (e) => reject(new Error(String(e.message || e).slice(0, 120))));
      // A browser that is already running hands the address to that instance and exits at once; a fresh one keeps running.
      setTimeout(() => { try { child.unref(); } catch (_) { /* gone */ } resolve(true); }, 150);
    });
  };
}

// The default browser, from Windows' own https association, read once.
function createDefaultBrowser({ execFile }) {
  let cached;
  const byText = (s) => (/firefox/i.test(s) ? BROWSERS[1] : /chrome/i.test(s) ? BROWSERS[0] : /msedge|\bedge\b/i.test(s) ? BROWSERS[2] : /brave/i.test(s) ? BROWSERS[3] : /opera/i.test(s) ? BROWSERS[4] : null);
  const query = (key, args) => new Promise((resolve) => execFile('reg.exe', ['query', key].concat(args), { windowsHide: true, timeout: 4000, encoding: 'utf8' }, (e, out) => resolve(String(out || ''))));
  return async function defaultBrowser() {
    if (cached !== undefined) return cached;
    try {
      const prog = await query('HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', ['/v', 'ProgId']);
      const m = /ProgId\s+REG_SZ\s+(\S+)/.exec(prog);
      const id = m ? m[1] : '';
      cached = byText(id);
      // A Store app's ProgId says nothing ("AppXycpy9mb5..."); its open command names the exe.
      if (!cached && id) cached = byText(await query('HKCR\\' + id + '\\shell\\open\\command', ['/ve']));
    } catch (_) { cached = null; }
    if (cached === undefined) cached = null;
    return cached;
  };
}

module.exports = { createActions, createFileSearch, cleanFileQuery, FILE_SEARCH_SCRIPT, createBrowserLaunch, createDefaultBrowser, browserFor, frontIs, parseKeys, findElement, fractionToPhys, HOME_FOLDERS, VK, MAX_TEXT, BROWSERS, APP_FRONT_MS };
