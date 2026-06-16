const { test } = require('node:test');
const assert = require('node:assert');
const { HEALTH, initialHealthState, deriveHealth } = require('../src/tracking-health');

// helper: feed a sequence of events, return final state
function run(events, state) {
  state = state || initialHealthState();
  for (const e of events) state = deriveHealth(state, e);
  return state;
}

test('first ok heartbeat with today sets baseline and counts', () => {
  const s = deriveHealth(initialHealthState(), { hbOk: true, today: 100 });
  assert.strictEqual(s.health, HEALTH.COUNTING);
  assert.strictEqual(s.windowBaseline, 100);
});

test('growth beyond tolerance stays counting and advances baseline', () => {
  const s = run([{ hbOk: true, today: 100 }, { hbOk: true, today: 120 }]);
  assert.strictEqual(s.health, HEALTH.COUNTING);
  assert.strictEqual(s.windowBaseline, 120);
});

test('three flat heartbeats become stalled', () => {
  const s = run([
    { hbOk: true, today: 100 }, // baseline
    { hbOk: true, today: 100 }, // strike 1
    { hbOk: true, today: 101 }, // strike 2 (<= tolerance 2, still no growth)
    { hbOk: true, today: 102 }, // strike 3
  ]);
  assert.strictEqual(s.health, HEALTH.STALLED);
});

test('growth within tolerance (<=2s) counts as no growth', () => {
  const s = run([{ hbOk: true, today: 100 }, { hbOk: true, today: 102 }]);
  assert.strictEqual(s.stallStrikes, 1);
  assert.strictEqual(s.health, HEALTH.COUNTING); // not yet 3 strikes
});

test('ok heartbeats without a today value go connecting -> stalled', () => {
  const s = run([
    { hbOk: true, today: null },
    { hbOk: true, today: null },
    { hbOk: true, today: null },
  ]);
  assert.strictEqual(s.health, HEALTH.STALLED);
});

test('two failures become disconnected', () => {
  const s = run([{ hbOk: true, today: 100 }, { hbOk: false, today: null }, { hbOk: false, today: null }]);
  assert.strictEqual(s.health, HEALTH.DISCONNECTED);
});

test('single failure does not flip yet', () => {
  const s = run([{ hbOk: true, today: 100 }, { hbOk: false, today: null }]);
  assert.strictEqual(s.health, HEALTH.COUNTING);
  assert.strictEqual(s.failStrikes, 1);
});

test('growth after stall recovers to counting', () => {
  const s = run([
    { hbOk: true, today: 100 },
    { hbOk: true, today: 100 },
    { hbOk: true, today: 100 },
    { hbOk: true, today: 100 }, // stalled here
    { hbOk: true, today: 130 }, // recovers
  ]);
  assert.strictEqual(s.health, HEALTH.COUNTING);
  assert.strictEqual(s.stallStrikes, 0);
});

test('a failure resets stall strikes', () => {
  const s = run([
    { hbOk: true, today: 100 },
    { hbOk: true, today: 100 }, // stall strike 1
    { hbOk: false, today: null }, // resets stall strikes, fail strike 1
  ]);
  assert.strictEqual(s.stallStrikes, 0);
  assert.strictEqual(s.failStrikes, 1);
});
