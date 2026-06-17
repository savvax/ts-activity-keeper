const { test } = require('node:test');
const assert = require('node:assert');
const { DEFAULTS, withDefaults, sanitize } = require('../src/settings');

test('DEFAULTS are reminder=5, sound=true (no mode)', () => {
  assert.deepStrictEqual(DEFAULTS, { notifyReminderMinutes: 5, notifySound: true });
});

test('withDefaults fills missing keys', () => {
  assert.deepStrictEqual(withDefaults({}), { notifyReminderMinutes: 5, notifySound: true });
  assert.deepStrictEqual(withDefaults({ notifyReminderMinutes: 9 }), { notifyReminderMinutes: 9, notifySound: true });
  assert.strictEqual(withDefaults({ notifySound: false }).notifySound, false);
});

test('sanitize clamps minutes to >=1 integer and coerces sound to bool', () => {
  assert.deepStrictEqual(sanitize({ notifyReminderMinutes: '3', notifySound: 1 }), { notifyReminderMinutes: 3, notifySound: true });
  assert.deepStrictEqual(sanitize({ notifyReminderMinutes: 0 }), { notifyReminderMinutes: 1 });
  assert.deepStrictEqual(sanitize({ notifyReminderMinutes: 'abc' }), { notifyReminderMinutes: 5 });
  assert.deepStrictEqual(sanitize({ notifySound: 0 }), { notifySound: false });
  assert.deepStrictEqual(sanitize({}), {});
});

test('mode is no longer part of the settings surface (API-only)', () => {
  // Legacy configs carrying a mode load without error; the key is ignored.
  assert.strictEqual('mode' in withDefaults({ mode: 'window' }), false);
  assert.strictEqual('mode' in withDefaults({ mode: 'background' }), false);
  assert.strictEqual(DEFAULTS.mode, undefined);
  // A mode in a save patch is dropped, never persisted.
  assert.deepStrictEqual(sanitize({ mode: 'window' }), {});
});
