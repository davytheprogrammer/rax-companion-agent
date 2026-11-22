'use strict';
// Linux X11 smoke test: real Chrome and pointer input against a local page.
// The model and platform adapter are scripted; this does not test Windows Hands.
// Run with: node scripts/hands-browser-smoke.js (requires google-chrome and xdotool).
const cp = require('child_process'), fs = require('fs'), http = require('http'), os = require('os'), path = require('path');
const root = path.resolve(__dirname, '..');
const { HandsAgent } = require(root + '/companion/src/hands/agent');
const { createActions } = require(root + '/companion/src/hands/actions');
const consent = require(root + '/companion/src/hands/consent');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-browser-smoke-'));
const exec = (cmd, args) => cp.execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let hits = 0, moved = false, browser = null, win = null;
const server = http.createServer((req, res) => {
  if (req.url === '/clicked') { hits++; res.writeHead(204); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>Rax browser smoke</title><style>body{margin:0}button{width:100vw;height:100vh;font-size:32px}</style><button onclick="fetch(\'/clicked\')">Open details</button>');
});
async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  browser = cp.spawn('google-chrome', ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + dir, '--new-window', url], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { win = exec('xdotool', ['search', '--onlyvisible', '--name', 'Rax browser smoke']).split('\n').at(-1); if (win) break; } catch (_) {} await sleep(250); }
  if (!win) throw Error('test browser did not open');
  exec('xdotool', ['windowactivate', '--sync', win]);
  exec('xdotool', ['windowsize', win, '900', '700']);
  exec('xdotool', ['windowmove', win, '100', '100']);
  await sleep(500);
  const fg = () => { const id = exec('xdotool', ['getactivewindow']); return { hwnd: Number(id), title: exec('xdotool', ['getwindowname', id]), process: 'chrome', rect: { x: 100, y: 100, w: 900, h: 700 } }; };
  const probe = { request: async op => op === 'fg' ? fg() : op === 'uia.frompoint' ? { element: { name: 'Open details', type: 'Button' } } : {} };
  const hands = { request: async (op, a) => {
    if (op === 'mouse.move') { exec('xdotool', ['mousemove', String(a.x), String(a.y)]); const location = exec('xdotool', ['getmouselocation', '--shell']); moved = location.includes('X=' + a.x + '\n') && location.includes('Y=' + a.y + '\n'); return { ok: moved }; }
    if (op === 'mouse.click') { exec('xdotool', ['mousemove', String(a.x), String(a.y), 'click', '1']); return { ok: true }; }
    throw Error('unexpected operation ' + op);
  } };
  const actions = createActions({ probe, hands, shell: {}, apps: [], sleep: async () => {} });
  const replies = ['Moving to the button. [DO:move_mouse {"x":0.5,"y":0.5}]', 'Opening the details. [DO:click {"x":0.5,"y":0.5}] [DONE]'];
  const trace = [];
  const agent = new HandsAgent({ read: async () => ({ fg: fg(), cap: { pxWidth: 900, pxHeight: 700, dataUrl: 'data:image/png;base64,' }, originPhys: { x: 100, y: 100 }, elements: [] }), foreground: async () => fg(), llm: () => ({ ready: true, provider: 'scripted-test', complete: async ({ onDelta }) => { const text = replies.shift(); if (!text) throw Error('unexpected model request'); onDelta(text); return text; } }), actions, consent: { preview: consent.preview, pending: consent.createPending() }, send: () => {}, sleep: async () => {}, log: m => trace.push(m) });
  await agent.run('Open the details on this page', 'typed');
  for (let i = 0; i < 20 && !hits; i++) await sleep(100);
  if (!moved || hits !== 1 || agent.last.outcome !== 'ok') throw Error('browser input was not verified; moved=' + moved + ', hits=' + hits + ', outcome=' + agent.last.outcome + '; ' + trace.join(' | '));
  console.log(JSON.stringify({ outcome: agent.last.outcome, pointerMoved: moved, pageClicks: hits, model: 'scripted', automation: 'real X11 pointer in disposable Chrome window' }));
}
run().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => { if (win) { try { exec('xdotool', ['windowclose', win]); } catch (_) {} } if (browser) browser.kill(); server.close(); setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 1000).unref(); });
