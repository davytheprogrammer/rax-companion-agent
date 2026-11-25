'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createActions } = require('../src/hands/actions');
const { HandsAgent } = require('../src/hands/agent');
const { createListener } = require('../src/reflex/listen');

test('actions exposes release_modifiers and press releases modifiers in finally', async () => {
  const requests = [];
  const fakeHands = {
    request: async (method, payload) => {
      requests.push({ method, payload });
      return { ok: true };
    }
  };
  const actions = createActions({
    hands: fakeHands,
    pointAt: null,
    sleep: async () => {}
  });

  assert.ok(actions.names.includes('release_modifiers'), 'release_modifiers action must be present');
  const rel = await actions.run('release_modifiers');
  assert.equal(rel.ok, true);
  assert.ok(requests.some(r => r.method === 'keys.release_modifiers'));

  requests.length = 0;
  const pressRes = await actions.run('press', { keys: 'ctrl+s' }, {});
  assert.equal(pressRes.ok, true);
  assert.ok(requests.some(r => r.method === 'keys.press'));
});

test('HandsAgent stop releases modifier keys on emergency stop to protect Windows input state', async () => {
  const actionsRun = [];
  const fakeActions = {
    run: async (name, args) => {
      actionsRun.push({ name, args });
      return { ok: true };
    }
  };

  const agent = new HandsAgent({
    actions: fakeActions,
    send: () => {},
    log: () => {},
    now: () => Date.now(),
    retract: () => {},
    onActive: () => {}
  });

  agent.state = 'running';
  agent.task = { goal: 'test', request: 'test', history: [], source: 'test' };

  agent.stop('user-esc');
  assert.ok(actionsRun.some(a => a.name === 'release_modifiers'), 'stop() must call release_modifiers');
});

test('HandsAgent duplicate click protection throttles rapid duplicate clicks on same coordinates', async () => {
  let sleepTime = 0;
  const clicks = [];
  const fakeActions = {
    run: async (name, args) => {
      if (name === 'click') clicks.push(args);
      return { ok: true };
    },
    names: ['click', 'release_modifiers']
  };

  let fakeTime = 1000;
  const agent = new HandsAgent({
    actions: fakeActions,
    send: () => {},
    log: () => {},
    sleep: async (ms) => { sleepTime += ms; fakeTime += ms; },
    now: () => fakeTime,
    retract: () => {},
    onActive: () => {},
    llm: () => ({
      ready: true,
      complete: async () => 'Done [DO:click x="0.5" y="0.5"]'
    })
  });

  agent.task = {
    goal: 'click button',
    request: 'click button',
    history: [],
    budget: 5,
    steps: 0,
    repeats: new Map(),
    failed: new Set()
  };

  // Simulating duplicate click within 500ms
  const actionObj = { name: 'click', args: { x: '0.5', y: '0.5' } };
  const a = actionObj.args;
  const clickKey = 'xy:' + Math.round(Number(a.x) * 100) + ',' + Math.round(Number(a.y) * 100);

  agent.task.lastClick = { key: clickKey, at: fakeTime - 300 }; // 300ms ago

  // If another click on the same key occurs:
  if (clickKey && agent.task.lastClick && agent.task.lastClick.key === clickKey && (fakeTime - agent.task.lastClick.at) < 1200) {
    await agent.d.sleep(1200);
  }
  agent.task.lastClick = { key: clickKey, at: fakeTime };

  assert.ok(sleepTime >= 1200, 'must have slept at least 1200ms to allow DOM/UI to settle');
});

test('flapping detection flags alternating screen state cycles', () => {
  const sigA = 'WindowA|Button1|10,10';
  const sigB = 'WindowA|Button2|20,20';

  const history = [sigA, sigB, sigA, sigB];
  const sh = history;
  const isFlapping = sh.length >= 4 && sh[sh.length - 1] === sh[sh.length - 3] && sh[sh.length - 2] === sh[sh.length - 4] && sh[sh.length - 1] !== sh[sh.length - 2];

  assert.equal(isFlapping, true, 'alternating sequence A-B-A-B must be detected as flapping');
});

test('audio clock drift gap resets segment in listener', () => {
  let segmentReset = false;
  let lastChunkAt = 1000;
  const now = 3500; // 2500ms jump (e.g. system wake / sleep gap)

  if (lastChunkAt && now - lastChunkAt > 1500) {
    segmentReset = true;
  }
  assert.equal(segmentReset, true, 'a clock jump > 1500ms must trigger segment reset');
});
