'use strict';
// The wake word: what counts as being spoken to, and the armed window.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWake, isVoiceSource, WAKE_SOURCE, ARMED_MS } = require('../src/handsfree/wake');

test('a line that starts with the name is a command, with the name taken off', () => {
  assert.deepEqual(parseWake('Rax, open Notepad'), { kind: 'command', text: 'open Notepad' });
  assert.deepEqual(parseWake('rax open notepad'), { kind: 'command', text: 'open notepad' });
  assert.deepEqual(parseWake('Hey Rax, reply to Mum'), { kind: 'command', text: 'reply to Mum' });
  assert.deepEqual(parseWake('Ok rax: scroll down'), { kind: 'command', text: 'scroll down' });
});

test('the name alone arms the Knot; the next words are the ask', () => {
  assert.deepEqual(parseWake('Rax?'), { kind: 'armed' });
  assert.deepEqual(parseWake('hey rax.'), { kind: 'armed' });
});

test('Rax is recognized in greetings and ordinary spoken commands', () => {
  const { greeting, isTask } = require('../src/reflex/rules');
  assert.deepEqual(greeting('Hello Rax'), { rest: '' });
  assert.deepEqual(greeting('Hey Rax, open Chrome'), { rest: 'open Chrome' });
  assert.equal(isTask('Rax, open Chrome'), true);
});

test('talk without the name is dropped', () => {
  assert.deepEqual(parseWake('open Notepad'), { kind: 'none' });
  assert.deepEqual(parseWake('I told them about nus yesterday'), { kind: 'none' });
  assert.deepEqual(parseWake('the news said so'), { kind: 'none' });
  assert.deepEqual(parseWake('nous sommes'), { kind: 'none' });
  assert.deepEqual(parseWake('raxophone'), { kind: 'none' });
  assert.deepEqual(parseWake('Nus open Notepad'), { kind: 'none' });
});

test('noise tags alone are nothing', () => {
  assert.deepEqual(parseWake('[BLANK_AUDIO]'), { kind: 'none' });
  assert.deepEqual(parseWake(''), { kind: 'none' });
});

test('after the name, the next words count for a short while without it', () => {
  const t0 = 1000000;
  const armed = t0 + ARMED_MS;
  assert.deepEqual(parseWake('scroll down', { now: t0 + 1000, armedUntil: armed }), { kind: 'command', text: 'scroll down' });
  assert.deepEqual(parseWake('scroll down', { now: armed + 1, armedUntil: armed }), { kind: 'none' });
  assert.deepEqual(parseWake('scroll down', { now: t0, armedUntil: 0 }), { kind: 'none' });
});

test('the voice source: the wake word counts as spoken, not as the open room', () => {
  assert.equal(isVoiceSource('voice'), true);
  assert.equal(isVoiceSource(WAKE_SOURCE), true);
  assert.equal(isVoiceSource('typed'), false);
  assert.equal(isVoiceSource(undefined), false);
  assert.notEqual(WAKE_SOURCE, 'voice');
});

test('wired: the room is gated after the tour and before the reflex layer, and the switch is in Settings and by voice', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const route = main.slice(main.indexOf('async function routeUtterance('));
  const gate = route.indexOf('parseWake(text');
  assert.ok(gate > 0, 'the gate is in routeUtterance');
  assert.ok(route.indexOf('tourHeard(text, source)') < gate, 'the tour hears first');
  assert.ok(gate < route.indexOf('getReflex()'), 'the gate runs before the reflex layer');
  assert.match(main, /source = WAKE_SOURCE;/);
  assert.match(main, /\[\/\\bwake word\\b\|\\bhands\[- \]\?free\\b\/i, 'wakeWord', 'Wake word'\]/, 'said by voice');
  const home = fs.readFileSync(path.join(__dirname, '..', 'home', 'home.js'), 'utf8');
  assert.match(home, /'wake-word':\['wakeWord'/, 'the Settings switch saves the setting');
});

test('hands-free audio never goes to a cloud speech service', () => {
  const { createSTT } = require('../src/stt');
  const withKeys = { apiKeys: { openai: 'sk-test', gemini: 'g-test' } };
  assert.equal(createSTT(withKeys).providers.includes('openai'), true, 'cloud is the fallback normally');
  const local = createSTT(withKeys, { localOnly: true });
  assert.ok(!local.providers.includes('openai') && !local.providers.includes('gemini'), 'no cloud provider in local-only mode');
});

test('the speech model is told the name when the wake word is on', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(main, /const out = WAKE_WORD \? \['Rax'\] : \[\];/);
});

test('hands-free listening uses local streaming without requiring the optional reflex provider', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(main, /ptt\.streaming = \(OPEN_MIC && WAKE_WORD \|\| getReflex\(\)\.enabled\(\)\) && getListener\(\)\.available/);
  assert.doesNotMatch(main, /OPEN_MIC && WAKE_WORD && \(!getReflex\(\)\.enabled\(\)/);
});

test('a firm card: a spoken yes is refused, but "confirm" from the wake word answers it', () => {
  const { createPending } = require('../src/hands/consent');
  const p = createPending({ now: () => 5000 });
  p.ask({ title: 'Send?', firm: true }, {}, {});
  assert.equal(p.spoken('yes', { heardAt: 6000 }), 'needs-button');
  assert.equal(p.spoken('confirm', { heardAt: 6000 }), 'needs-button', 'without the wake word, still the button');
  const q = createPending({ now: () => 5000 });
  q.ask({ title: 'Send?', firm: true }, {}, {});
  assert.equal(q.spoken('confirm', { heardAt: 6000, wakeConfirm: true }), 'yes');
  const r = createPending({ now: () => 5000 });
  r.ask({ title: 'Send?', firm: true }, {}, {});
  assert.equal(r.spoken('open notepad', { heardAt: 6000, wakeConfirm: true }), 'cancelled', 'anything else still cancels');
});
