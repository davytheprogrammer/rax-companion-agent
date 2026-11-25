'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

// Mock electron before requiring store
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      getPath: (name) => os.tmpdir(),
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s) => Buffer.from(s),
      decryptString: (b) => b.toString(),
    }
  }
};

const store = require('../src/store');
const { parseWake, ARMED_MS } = require('../src/handsfree/wake');

test('store maintains handsAutonomous and apiKeys.meta in settings defaults and updates', () => {
  const initial = store.getSettings();
  assert.equal(typeof initial.handsAutonomous, 'boolean', 'handsAutonomous must be boolean in settings');
  assert.ok(initial.apiKeys, 'apiKeys must exist');
  assert.equal(typeof initial.apiKeys.meta, 'string', 'apiKeys.meta must be string');

  store.setSettings({ handsAutonomous: true, apiKeys: { meta: 'test-meta-key-123' } });
  const updated = store.getSettings();
  assert.equal(updated.handsAutonomous, true);
  assert.equal(updated.apiKeys.meta, 'test-meta-key-123');

  // restore default
  store.setSettings({ handsAutonomous: false, apiKeys: { meta: '' } });
});

test('parseWake arms when name alone is spoken, then accepts subsequent ask', () => {
  const now = 10000;
  const armed = parseWake('Rax', { now, armedUntil: 0 });
  assert.equal(armed.kind, 'armed');

  const ask = parseWake('open notepad', { now: now + 1000, armedUntil: now + ARMED_MS });
  assert.equal(ask.kind, 'command');
  assert.equal(ask.text, 'open notepad');
});

test('parseWake ignores speech after armed window expires', () => {
  const now = 10000;
  const expired = parseWake('open notepad', { now: now + ARMED_MS + 500, armedUntil: now + ARMED_MS });
  assert.equal(expired.kind, 'none');
});
