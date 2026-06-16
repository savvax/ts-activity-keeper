const { test } = require('node:test');
const assert = require('node:assert');
const { createNotifier } = require('../src/notifier');

function harness() {
  const shown = [];
  let timerId = 0;
  const timers = new Map();
  const notifier = createNotifier({
    createNotification: (opts) => ({ show: () => shown.push(opts) }),
    setInterval: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { timers.delete(id); },
  });
  return { notifier, shown, timers };
}

const S = { notifyReminderMinutes: 5, notifySound: true };

test('notCounting shows once and starts a reminder', () => {
  const h = harness();
  h.notifier.notCounting('No server connection', S);
  assert.strictEqual(h.shown.length, 1);
  assert.strictEqual(h.shown[0].silent, false);
  assert.strictEqual(h.timers.size, 1);
});

test('repeat notCounting does not re-show or restart timer', () => {
  const h = harness();
  h.notifier.notCounting('No server connection', S);
  h.notifier.notCounting('Not counting (offline)', S);
  assert.strictEqual(h.shown.length, 1);
  assert.strictEqual(h.timers.size, 1);
});

test('reminder fires the repeat message', () => {
  const h = harness();
  h.notifier.notCounting('No server connection', S);
  const id = [...h.timers.keys()][0];
  h.timers.get(id).fn(); // simulate one interval tick
  assert.strictEqual(h.shown.length, 2);
  assert.match(h.shown[1].body, /still not being counted/);
});

test('restored shows once and clears reminder when previously notifying', () => {
  const h = harness();
  h.notifier.notCounting('No server connection', S);
  h.notifier.restored(S);
  assert.strictEqual(h.shown.length, 2);
  assert.match(h.shown[1].body, /Connection restored/);
  assert.strictEqual(h.timers.size, 0);
});

test('restored without prior notCounting shows nothing', () => {
  const h = harness();
  h.notifier.restored(S);
  assert.strictEqual(h.shown.length, 0);
});

test('silent flag follows notifySound=false', () => {
  const h = harness();
  h.notifier.notCounting('x', { notifyReminderMinutes: 5, notifySound: false });
  assert.strictEqual(h.shown[0].silent, true);
});

test('re-entry updates the reminder message and silent flag', () => {
  const h = harness();
  h.notifier.notCounting('No server connection', { notifyReminderMinutes: 5, notifySound: true });
  // re-enter (e.g. stalled -> disconnected) with sound now off and a new message
  h.notifier.notCounting('Not counting (offline)', { notifyReminderMinutes: 5, notifySound: false });
  assert.strictEqual(h.shown.length, 1); // idempotent: no second immediate notification
  const id = [...h.timers.keys()][0];
  h.timers.get(id).fn(); // reminder tick reflects latest call
  assert.match(h.shown[1].body, /Not counting \(offline\)/);
  assert.strictEqual(h.shown[1].silent, true);
});

test('stop clears reminder and resets notifying', () => {
  const h = harness();
  h.notifier.notCounting('x', S);
  h.notifier.stop();
  assert.strictEqual(h.timers.size, 0);
  h.notifier.restored(S); // should not show, since stop reset state
  assert.strictEqual(h.shown.length, 1);
});
