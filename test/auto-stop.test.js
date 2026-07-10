const { test } = require('node:test');
const assert = require('node:assert');
const { createAutoStop } = require('../src/auto-stop');

test('disarmed by default', () => {
  const a = createAutoStop(() => 0);
  assert.strictEqual(a.isArmed(), false);
  assert.strictEqual(a.remainingMs(), null);
  assert.strictEqual(a.expired(), false);
});

test('arm sets a deadline and counts down', () => {
  let now = 1000;
  const a = createAutoStop(() => now);
  a.arm(60000);
  assert.strictEqual(a.isArmed(), true);
  assert.strictEqual(a.remainingMs(), 60000);
  now = 31000;
  assert.strictEqual(a.remainingMs(), 30000);
  assert.strictEqual(a.expired(), false);
  now = 61000;
  assert.strictEqual(a.expired(), true);
  assert.strictEqual(a.remainingMs(), 0);
});

test('arm with zero or negative duration disarms', () => {
  let now = 1000;
  const a = createAutoStop(() => now);
  a.arm(60000);
  a.arm(0);
  assert.strictEqual(a.isArmed(), false);
  a.arm(-5);
  assert.strictEqual(a.isArmed(), false);
});

test('re-arm replaces the deadline', () => {
  let now = 0;
  const a = createAutoStop(() => now);
  a.arm(1000);
  now = 900;
  a.arm(60000); // settings changed mid-run
  now = 1100;
  assert.strictEqual(a.expired(), false);
  assert.strictEqual(a.remainingMs(), 59800);
});

test('disarm clears expiry', () => {
  let now = 0;
  const a = createAutoStop(() => now);
  a.arm(100);
  now = 200;
  assert.strictEqual(a.expired(), true);
  a.disarm();
  assert.strictEqual(a.expired(), false);
  assert.strictEqual(a.remainingMs(), null);
});
