const { test } = require('node:test');
const assert = require('node:assert');
const { createSessionClock } = require('../src/session-clock');

test('elapsed accrues only while counting (resume/pause)', () => {
  let now = 1000;
  const clock = createSessionClock(() => now);
  clock.reset();
  assert.strictEqual(clock.elapsedMs(), 0);

  clock.resume();        // start counting at 1000
  now = 4000;            // +3000 while counting
  assert.strictEqual(clock.elapsedMs(), 3000);

  clock.pause();         // freeze at 3000
  now = 10000;           // time passes, not counted
  assert.strictEqual(clock.elapsedMs(), 3000);

  clock.resume();        // resume at 10000
  now = 11000;           // +1000
  assert.strictEqual(clock.elapsedMs(), 4000);
});

test('double resume does not lose time', () => {
  let now = 0;
  const clock = createSessionClock(() => now);
  clock.resume();
  now = 1000;
  clock.resume(); // no-op
  now = 2000;
  assert.strictEqual(clock.elapsedMs(), 2000);
});

test('reset clears counted time', () => {
  let now = 0;
  const clock = createSessionClock(() => now);
  clock.resume();
  now = 5000;
  clock.reset();
  assert.strictEqual(clock.elapsedMs(), 0);
  assert.strictEqual(clock.isCounting(), false);
});
