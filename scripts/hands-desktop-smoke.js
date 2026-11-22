'use strict';
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
// Linux X11 smoke test: real editor and input; the model and platform adapter are scripted.
// Run with: node scripts/hands-desktop-smoke.js (requires gedit and xdotool).
const root = path.resolve(__dirname, '..');
const { HandsAgent } = require(root + '/companion/src/hands/agent');
const { createActions } = require(root + '/companion/src/hands/actions');
const consent = require(root + '/companion/src/hands/consent');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-control-'));
const file = path.join(temp, 'hands-proof.txt'); fs.writeFileSync(file, '');
const exec = (cmd, args) => cp.execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 }).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const editor = cp.spawn('gedit', ['--standalone', '--new-window', file], { stdio: 'ignore' });
let win;
async function run() {
  for (let i = 0; i < 40; i++) { try { win = exec('xdotool', ['search', '--onlyvisible', '--name', 'hands-proof.txt']).split('\n').at(-1); if (win) break; } catch (_) {} await sleep(250); }
  if (!win) throw Error('test editor did not open');
  exec('xdotool', ['windowactivate', '--sync', win]);
  const fg = () => { const id = exec('xdotool', ['getactivewindow']); return { hwnd: Number(id), title: exec('xdotool', ['getwindowname', id]), process: 'gedit', rect: { x: 0, y: 0, w: 1000, h: 700 } }; };
  const probe = { request: async op => op === 'fg' ? fg() : op === 'uia.focused' ? { element: { name: 'editor', type: 'Edit', isPassword: false } } : {} };
  const hands = { request: async (op, a) => {
    if (op === 'keys.text') { exec('xdotool', ['type', '--clearmodifiers', '--delay', '1', '--', a.text]); return { ok: true, verified: true, window: fg().title, focus: 'editor' }; }
    if (op === 'keys.press') { const names = a.keys.map(k => ({ 17: 'ctrl', 83: 's' })[k]); if (names.some(x => !x)) throw Error('unexpected key'); exec('xdotool', ['key', '--clearmodifiers', names.join('+')]); return { ok: true }; }
    throw Error('unexpected operation ' + op);
  } };
  const actions = createActions({ probe, hands, shell: {}, apps: [], sleep: async () => {} });
  const replies = ['Writing the requested line. [DO:type {"text":"Rax hands control verified"}]', 'Saving the document. [DO:press {"keys":"ctrl+s"}] [DONE]'];
  const sent = [];
  const agent = new HandsAgent({ read: async () => ({ fg: fg(), cap: null, elements: [] }), foreground: async () => fg(), llm: () => ({ ready: true, provider: 'scripted-test', complete: async ({ onDelta }) => { const text = replies.shift(); if (!text) throw Error('unexpected extra model request'); onDelta(text); return text; } }), actions, consent: { preview: consent.preview, pending: consent.createPending() }, send: (ch, data) => sent.push({ ch, data }), sleep: async () => {}, log: () => {} });
  await agent.run('Type Rax hands control verified into the open editor and save it', 'typed');
  await sleep(600);
  const actual = fs.readFileSync(file, 'utf8');
  if (actual.replace(/\r?\n$/, '') !== 'Rax hands control verified') throw Error('saved content mismatch: ' + JSON.stringify(actual));
  if (agent.last.outcome !== 'ok') throw Error('agent outcome: ' + agent.last.outcome);
  console.log(JSON.stringify({ outcome: agent.last.outcome, savedContent: actual, steps: agent.last.steps, model: 'scripted', automation: 'real X11 input in disposable gedit window' }));
}
run().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => { if (win) { try { exec('xdotool', ['windowclose', win]); } catch (_) {} } editor.kill(); fs.rmSync(temp, { recursive: true, force: true }); });
