const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { createActions } = require('../src/hands/actions');
const consent = require('../src/hands/consent');

test('actions includes run_command and clipboard actions', () => {
  const actions = createActions({
    hands: { request: async () => ({ ok: true }) },
  });
  assert.ok(actions.names.includes('run_command'), 'run_command should be registered');
  assert.ok(actions.names.includes('get_clipboard'), 'get_clipboard should be registered');
  assert.ok(actions.names.includes('set_clipboard'), 'set_clipboard should be registered');
  assert.ok(actions.names.includes('switch_window'), 'switch_window should be registered');
  assert.ok(actions.names.includes('read_file'), 'read_file should be registered');
  assert.ok(actions.names.includes('write_file'), 'write_file should be registered');
  assert.ok(actions.names.includes('list_directory'), 'list_directory should be registered');
  assert.ok(actions.names.includes('http_request'), 'http_request should be registered');
  assert.ok(actions.names.includes('get_system_info'), 'get_system_info should be registered');
  assert.ok(actions.names.includes('list_processes'), 'list_processes should be registered');
  assert.ok(actions.names.includes('kill_process'), 'kill_process should be registered');
  assert.ok(actions.names.includes('show_notification'), 'show_notification should be registered');
  assert.ok(actions.names.includes('paste_text'), 'paste_text should be registered');
});

test('run_command executes command and returns output', async () => {
  const actions = createActions({
    hands: { request: async () => ({ ok: true }) },
  });
  const res = await actions.run('run_command', { command: 'node -e "console.log(12345)"' });
  assert.equal(res.ok, true);
  assert.match(res.content, /12345/);
});

test('write_file and read_file work seamlessly', async () => {
  const actions = createActions({
    hands: { request: async () => ({ ok: true }) },
  });
  const tmpFile = path.join(os.tmpdir(), `rax-test-${Date.now()}.txt`);
  try {
    const writeRes = await actions.run('write_file', { path: tmpFile, content: 'Limitless Rax Agent Power' });
    assert.equal(writeRes.ok, true);

    const readRes = await actions.run('read_file', { path: tmpFile });
    assert.equal(readRes.ok, true);
    assert.equal(readRes.content, 'Limitless Rax Agent Power');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
});

test('get_system_info returns os and memory diagnostics', async () => {
  const actions = createActions({
    hands: { request: async () => ({ ok: true }) },
  });
  const res = await actions.run('get_system_info', {});
  assert.equal(res.ok, true);
  const data = JSON.parse(res.content);
  assert.ok(data.platform);
  assert.ok(data.cpu);
  assert.ok(data.memory);
});

test('list_directory returns entries', async () => {
  const actions = createActions({
    hands: { request: async () => ({ ok: true }) },
  });
  const res = await actions.run('list_directory', { path: __dirname });
  assert.equal(res.ok, true);
  assert.match(res.content, /autonomous-hands\.test\.js/);
});

test('autonomous mode skips confirmation for regular UI actions', () => {
  const closeAction = { name: 'window_close' };
  const card = consent.preview(closeAction, { windowTitle: 'Test Window', autonomous: true });
  assert.equal(card, null, 'regular window_close should not require approval in autonomous mode');
});

test('autonomous mode still guards money and checkout', () => {
  const payAction = { name: 'click', args: { text: 'Pay $50 Now' } };
  const card = consent.preview(payAction, { targetName: 'Pay $50 Now', autonomous: true });
  assert.notEqual(card, null, 'spending money must still require confirmation');
  assert.equal(card.firm, true);
});
