const test = require('node:test');
const assert = require('node:assert/strict');
const { isAdmin, ensureAdmin } = require('./elevate');

test('isAdmin returns boolean', () => {
  const admin = isAdmin();
  assert.equal(typeof admin, 'boolean');
});

test('ensureAdmin skips elevation in smoke mode', () => {
  const res = ensureAdmin({ argv: ['node', 'app.js', '--smoke'] });
  assert.equal(res, true);
});

test('ensureAdmin skips elevation when --no-elevate is passed', () => {
  const res = ensureAdmin({ argv: ['node', 'app.js', '--no-elevate'] });
  assert.equal(res, true);
});
