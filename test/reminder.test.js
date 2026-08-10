const { test } = require('node:test');
const assert = require('node:assert');
const { createReminder } = require('../src/reminder');

// Управляемые таймеры: сохраняем колбэки и дёргаем их вручную.
function harness(minutes = 5) {
  const sent = [];
  const timers = new Map();
  let nextId = 1;
  let interval = minutes;
  const reminder = createReminder({
    send: (text) => sent.push(text),
    setInterval: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { timers.delete(id); },
    getIntervalMinutes: () => interval,
  });
  return {
    reminder, sent, timers,
    setInterval_: (m) => { interval = m; },
    tick: () => { for (const t of timers.values()) t.fn(); },
  };
}

test('notCounting шлёт сообщение сразу и заводит повтор', () => {
  const h = harness(5);
  h.reminder.notCounting('нет связи с сервером');
  assert.strictEqual(h.sent.length, 1);
  assert.match(h.sent[0], /нет связи с сервером/);
  assert.strictEqual(h.timers.size, 1);
  assert.strictEqual([...h.timers.values()][0].ms, 5 * 60 * 1000);
});

test('повторы уходят по тику таймера', () => {
  const h = harness(5);
  h.reminder.notCounting('нет связи с сервером');
  h.tick();
  h.tick();
  assert.strictEqual(h.sent.length, 3);
  assert.match(h.sent[2], /всё ещё/i);
});

test('повторный notCounting не дублирует сообщение, но обновляет текст', () => {
  const h = harness(5);
  h.reminder.notCounting('первая причина');
  h.reminder.notCounting('вторая причина');
  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.timers.size, 1);
  h.tick();
  assert.match(h.sent[1], /вторая причина/);
});

test('remindMinutes = 0 — одно сообщение без повторов', () => {
  const h = harness(0);
  h.reminder.notCounting('нет связи');
  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.timers.size, 0);
});

test('restored шлёт сообщение и гасит таймер только если было падение', () => {
  const h = harness(5);
  h.reminder.restored();
  assert.strictEqual(h.sent.length, 0);

  h.reminder.notCounting('нет связи');
  h.reminder.restored();
  assert.strictEqual(h.sent.length, 2);
  assert.match(h.sent[1], /восстановлена|снова считается/i);
  assert.strictEqual(h.timers.size, 0);
  assert.strictEqual(h.reminder.isNotifying(), false);
});

test('stop гасит таймер молча', () => {
  const h = harness(5);
  h.reminder.notCounting('нет связи');
  h.reminder.stop();
  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.timers.size, 0);
  assert.strictEqual(h.reminder.isNotifying(), false);
});
