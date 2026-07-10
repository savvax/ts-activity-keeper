const { test } = require('node:test');
const assert = require('node:assert');
const { DEFAULTS, withDefaults, sanitize } = require('../src/settings');

test('DEFAULTS cover notifications, privacy, auto-stop and telegram', () => {
  assert.deepStrictEqual(DEFAULTS, {
    notifyReminderMinutes: 5,
    notifySound: true,
    hideLogin: false,
    autoStopMinutes: 0,
    autoStopLogout: false,
    telegramToken: '',
    telegramChatId: '',
  });
});

test('withDefaults fills missing keys', () => {
  assert.deepStrictEqual(withDefaults({}), DEFAULTS);
  assert.strictEqual(withDefaults({ notifyReminderMinutes: 9 }).notifyReminderMinutes, 9);
  assert.strictEqual(withDefaults({ notifySound: false }).notifySound, false);
  assert.strictEqual(withDefaults({ hideLogin: true }).hideLogin, true);
  assert.strictEqual(withDefaults({ autoStopMinutes: 90 }).autoStopMinutes, 90);
  assert.strictEqual(withDefaults({ telegramToken: 't' }).telegramToken, 't');
});

test('sanitize clamps minutes to >=1 integer and coerces sound to bool', () => {
  assert.deepStrictEqual(sanitize({ notifyReminderMinutes: '3', notifySound: 1 }), { notifyReminderMinutes: 3, notifySound: true });
  assert.deepStrictEqual(sanitize({ notifyReminderMinutes: 0 }), { notifyReminderMinutes: 1 });
  assert.deepStrictEqual(sanitize({ notifyReminderMinutes: 'abc' }), { notifyReminderMinutes: 5 });
  assert.deepStrictEqual(sanitize({ notifySound: 0 }), { notifySound: false });
  assert.deepStrictEqual(sanitize({}), {});
});

test('hideLogin is one-way: only true is accepted, false is dropped', () => {
  assert.deepStrictEqual(sanitize({ hideLogin: true }), { hideLogin: true });
  assert.deepStrictEqual(sanitize({ hideLogin: false }), {});
  assert.deepStrictEqual(sanitize({ hideLogin: 1 }), {}); // strict true only
});

test('autoStopMinutes clamps to >=0 integer, 0 disables', () => {
  assert.deepStrictEqual(sanitize({ autoStopMinutes: '45' }), { autoStopMinutes: 45 });
  assert.deepStrictEqual(sanitize({ autoStopMinutes: -5 }), { autoStopMinutes: 0 });
  assert.deepStrictEqual(sanitize({ autoStopMinutes: 'x' }), { autoStopMinutes: 0 });
  assert.deepStrictEqual(sanitize({ autoStopLogout: 1 }), { autoStopLogout: true });
});

test('telegram keys are trimmed strings', () => {
  assert.deepStrictEqual(sanitize({ telegramToken: '  123:abc ' }), { telegramToken: '123:abc' });
  assert.deepStrictEqual(sanitize({ telegramChatId: 42 }), { telegramChatId: '42' });
  // empty string clears the key (used by /revoke)
  assert.deepStrictEqual(sanitize({ telegramToken: '' }), { telegramToken: '' });
});

test('mode is no longer part of the settings surface (API-only)', () => {
  // Legacy configs carrying a mode load without error; the key is ignored.
  assert.strictEqual('mode' in withDefaults({ mode: 'window' }), false);
  assert.strictEqual(DEFAULTS.mode, undefined);
  // A mode in a save patch is dropped, never persisted.
  assert.deepStrictEqual(sanitize({ mode: 'window' }), {});
});
