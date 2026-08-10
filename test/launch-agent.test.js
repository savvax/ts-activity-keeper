const { test } = require('node:test');
const assert = require('node:assert');
const { ensureAutostart, describeAutostart, isBadLocation } = require('../src/launch-agent');

function fakeApp(opts = {}) {
  let openAtLogin = !!opts.openAtLogin;
  return {
    calls: [],
    isPackaged: opts.isPackaged !== false,
    getPath: () => opts.exePath || '/Applications/TS Activity Keeper.app/Contents/MacOS/TS Activity Keeper',
    getLoginItemSettings() { return { openAtLogin }; },
    setLoginItemSettings(o) {
      this.calls.push(o);
      if (opts.throwOnSet) throw new Error('not permitted');
      if (!opts.silentlyIgnores) openAtLogin = !!o.openAtLogin;
    },
  };
}

test('уже включён — ничего не трогаем', () => {
  const app = fakeApp({ openAtLogin: true });
  const r = ensureAutostart({ app, desired: true });
  assert.deepStrictEqual(r, { desired: true, actual: true, ok: true, reason: 'already' });
  assert.strictEqual(app.calls.length, 0);
});

test('успешное включение', () => {
  const app = fakeApp({ openAtLogin: false });
  const r = ensureAutostart({ app, desired: true });
  assert.deepStrictEqual(r, { desired: true, actual: true, ok: true, reason: 'set' });
  assert.deepStrictEqual(app.calls, [{ openAtLogin: true }]);
});

test('молчаливый отказ системы ловится перечитыванием настройки', () => {
  const app = fakeApp({ openAtLogin: false, silentlyIgnores: true });
  const r = ensureAutostart({ app, desired: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.actual, false);
  assert.strictEqual(r.reason, 'denied');
});

test('исключение при установке — reason denied, без throw наружу', () => {
  const app = fakeApp({ openAtLogin: false, throwOnSet: true });
  const r = ensureAutostart({ app, desired: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'denied');
});

test('App Translocation и запуск не из /Applications дают reason location', () => {
  const translocated = fakeApp({
    exePath: '/private/var/folders/x1/AppTranslocation/ABC/d/TS Activity Keeper.app/Contents/MacOS/TS Activity Keeper',
  });
  assert.strictEqual(ensureAutostart({ app: translocated, desired: true }).reason, 'location');
  assert.strictEqual(translocated.calls.length, 0);

  const downloads = fakeApp({ exePath: '/Users/me/Downloads/TS Activity Keeper.app/Contents/MacOS/x' });
  assert.strictEqual(ensureAutostart({ app: downloads, desired: true }).reason, 'location');
});

test('в дев-режиме (не packaged) расположение не проверяется', () => {
  const app = fakeApp({ exePath: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron' });
  const r = ensureAutostart({ app, desired: true, packaged: false });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, 'set');
});

test('desired=false выключает автозапуск', () => {
  const app = fakeApp({ openAtLogin: true });
  const r = ensureAutostart({ app, desired: false });
  assert.deepStrictEqual(app.calls, [{ openAtLogin: false }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, 'disabled');
  assert.strictEqual(r.actual, false);
});

test('isBadLocation', () => {
  assert.strictEqual(isBadLocation('/Applications/X.app/Contents/MacOS/X'), false);
  assert.strictEqual(isBadLocation('/private/var/folders/q/X.app/Contents/MacOS/X'), true);
  assert.strictEqual(isBadLocation('/Users/me/Desktop/X.app/Contents/MacOS/X'), true);
  assert.strictEqual(isBadLocation(''), false);
});

test('describeAutostart даёт понятный текст на каждую причину', () => {
  assert.match(describeAutostart({ desired: true, ok: true, reason: 'set' }), /включ/i);
  assert.match(describeAutostart({ desired: false, ok: true, reason: 'disabled' }), /выкл/i);
  assert.match(describeAutostart({ desired: true, ok: false, reason: 'location' }), /Applications/);
  assert.match(describeAutostart({ desired: true, ok: false, reason: 'denied' }), /Объекты входа/);
});
