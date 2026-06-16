const { test } = require('node:test');
const assert = require('node:assert');
const { DEFAULTS, withDefaults, sanitize, VALID_MODES } = require('../src/settings');

test('DEFAULTS are reminder=5, sound=true, mode=api', () => {
  assert.deepStrictEqual(DEFAULTS, { notifyReminderMinutes: 5, notifySound: true, mode: 'api' });
});

test('withDefaults fills missing keys', () => {
  assert.deepStrictEqual(withDefaults({}), { notifyReminderMinutes: 5, notifySound: true, mode: 'api' });
  assert.deepStrictEqual(withDefaults({ notifyReminderMinutes: 9 }), { notifyReminderMinutes: 9, notifySound: true, mode: 'api' });
  assert.strictEqual(withDefaults({ notifySound: false }).notifySound, false);
});

test('sanitize clamps minutes to >=1 integer and coerces sound to bool', () => {
  assert.deepStrictEqual(sanitize({ notifyReminderMinutes: '3', notifySound: 1 }), { notifyReminderMinutes: 3, notifySound: true });
  assert.deepStrictEqual(sanitize({ notifyReminderMinutes: 0 }), { notifyReminderMinutes: 1 });
  assert.deepStrictEqual(sanitize({ notifyReminderMinutes: 'abc' }), { notifyReminderMinutes: 5 });
  assert.deepStrictEqual(sanitize({ notifySound: 0 }), { notifySound: false });
  assert.deepStrictEqual(sanitize({}), {});
});

test('DEFAULTS include mode=api', () => {
  assert.strictEqual(DEFAULTS.mode, 'api');
});

test('withDefaults fills and validates mode', () => {
  assert.strictEqual(withDefaults({}).mode, 'api');
  assert.strictEqual(withDefaults({ mode: 'api' }).mode, 'api');
  assert.strictEqual(withDefaults({ mode: 'background' }).mode, 'background');
  assert.strictEqual(withDefaults({ mode: 'bogus' }).mode, 'api');
});

test('sanitize validates mode and drops unknown', () => {
  assert.deepStrictEqual(sanitize({ mode: 'api' }), { mode: 'api' });
  assert.deepStrictEqual(sanitize({ mode: 'nope' }), { mode: 'api' });
  assert.deepStrictEqual(sanitize({}), {});
  assert.deepStrictEqual(VALID_MODES, ['window', 'background', 'api']);
});
