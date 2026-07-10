const { test } = require('node:test');
const assert = require('node:assert');
const { createNotifier } = require('../src/notifier');

function harness(initialSettings) {
  const shown = [];
  let timerId = 0;
  const timers = new Map();
  const settings = { notifyReminderMinutes: 5, notifySound: true, ...initialSettings };
  const notifier = createNotifier({
    createNotification: (opts) => ({ show: () => shown.push(opts) }),
    setInterval: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { timers.delete(id); },
    getSettings: () => settings,
  });
  return { notifier, shown, timers, settings };
}

test('notCounting shows once and starts a reminder', () => {
  const h = harness();
  h.notifier.notCounting('No server connection');
  assert.strictEqual(h.shown.length, 1);
  assert.strictEqual(h.shown[0].silent, false);
  assert.strictEqual(h.timers.size, 1);
});

test('repeat notCounting does not re-show or restart timer', () => {
  const h = harness();
  h.notifier.notCounting('No server connection');
  h.notifier.notCounting('Not counting (offline)');
  assert.strictEqual(h.shown.length, 1);
  assert.strictEqual(h.timers.size, 1);
});

test('reminder fires the repeat message', () => {
  const h = harness();
  h.notifier.notCounting('No server connection');
  const id = [...h.timers.keys()][0];
  h.timers.get(id).fn(); // simulate one interval tick
  assert.strictEqual(h.shown.length, 2);
  assert.match(h.shown[1].body, /still not being counted/);
});

test('restored shows once and clears reminder when previously notifying', () => {
  const h = harness();
  h.notifier.notCounting('No server connection');
  h.notifier.restored();
  assert.strictEqual(h.shown.length, 2);
  assert.match(h.shown[1].body, /Connection restored/);
  assert.strictEqual(h.timers.size, 0);
});

test('restored without prior notCounting shows nothing', () => {
  const h = harness();
  h.notifier.restored();
  assert.strictEqual(h.shown.length, 0);
});

test('silent flag follows notifySound=false', () => {
  const h = harness({ notifySound: false });
  h.notifier.notCounting('x');
  assert.strictEqual(h.shown[0].silent, true);
});

test('sound toggle takes effect for an already-running reminder', () => {
  const h = harness({ notifySound: true });
  h.notifier.notCounting('No server connection');
  assert.strictEqual(h.shown[0].silent, false);
  h.settings.notifySound = false; // user flips the setting mid-reminder
  const id = [...h.timers.keys()][0];
  h.timers.get(id).fn();
  assert.strictEqual(h.shown[1].silent, true);
});

test('re-entry updates the reminder message', () => {
  const h = harness();
  h.notifier.notCounting('No server connection');
  h.notifier.notCounting('Not counting (offline)');
  assert.strictEqual(h.shown.length, 1); // idempotent: no second immediate notification
  const id = [...h.timers.keys()][0];
  h.timers.get(id).fn(); // reminder tick reflects latest call
  assert.match(h.shown[1].body, /Not counting \(offline\)/);
});

test('info shows a one-off notification honoring the sound setting', () => {
  const h = harness({ notifySound: false });
  h.notifier.info('Auto-stop: tracking stopped');
  assert.strictEqual(h.shown.length, 1);
  assert.strictEqual(h.shown[0].silent, true);
  assert.strictEqual(h.timers.size, 0);
});

test('stop clears reminder and resets notifying', () => {
  const h = harness();
  h.notifier.notCounting('x');
  h.notifier.stop();
  assert.strictEqual(h.timers.size, 0);
  h.notifier.restored(); // should not show, since stop reset state
  assert.strictEqual(h.shown.length, 1);
});
