const { test } = require('node:test');
const assert = require('node:assert');
const { maskLogin, formatDuration, formatSeconds } = require('../src/utils');

test('maskLogin masks local part and domain', () => {
  assert.strictEqual(maskLogin('jd691337x@gmail.com'), 'jd•••@g•••');
  assert.strictEqual(maskLogin('someone@example.org'), 'so•••@e•••');
});

test('maskLogin handles plain logins without a domain', () => {
  assert.strictEqual(maskLogin('savva'), 'sa•••');
  assert.strictEqual(maskLogin('ab'), 'a•••');
  assert.strictEqual(maskLogin('a'), 'a•••');
});

test('maskLogin of empty input is empty', () => {
  assert.strictEqual(maskLogin(''), '');
  assert.strictEqual(maskLogin(null), '');
});

test('formatDuration and formatSeconds pad to HH:MM:SS', () => {
  assert.strictEqual(formatDuration(3661000), '01:01:01');
  assert.strictEqual(formatSeconds(3661), '01:01:01');
  assert.strictEqual(formatSeconds(0), '00:00:00');
});
