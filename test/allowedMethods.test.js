process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allowedMethods } = require('../src/lib/allowedMethods');

test('allowedMethods returns the documented methods for a spec path', () => {
  assert.equal(allowedMethods('/auth/login'), 'POST');
});

test('allowedMethods matches templated segments but not regex look-alikes', () => {
  assert.ok(allowedMethods('/auth/challenges/abc123'));
  assert.equal(allowedMethods('/authXlogin'), undefined);
  assert.equal(allowedMethods('/nope'), undefined);
});
