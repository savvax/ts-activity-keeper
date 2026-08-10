const { test } = require('node:test');
const assert = require('node:assert');
const { loadBuildSecrets } = require('../src/build-config-loader');

test('берёт вшитые значения из build-config', () => {
  const out = loadBuildSecrets({
    requireFn: () => ({ TELEGRAM_BOT_TOKEN: '111:aaa', PAIRING_SECRET: 'hunter2' }),
    env: {},
  });
  assert.deepStrictEqual(out, { token: '111:aaa', secret: 'hunter2' });
});

test('вшитые значения приоритетнее ENV', () => {
  const out = loadBuildSecrets({
    requireFn: () => ({ TELEGRAM_BOT_TOKEN: '111:aaa', PAIRING_SECRET: 'baked' }),
    env: { TELEGRAM_BOT_TOKEN: '222:bbb', TELEGRAM_SECRET: 'env' },
  });
  assert.deepStrictEqual(out, { token: '111:aaa', secret: 'baked' });
});

test('без build-config подхватывает ENV', () => {
  const out = loadBuildSecrets({
    requireFn: () => { throw new Error("Cannot find module './build-config'"); },
    env: { TELEGRAM_BOT_TOKEN: ' 222:bbb ', TELEGRAM_SECRET: ' env ' },
  });
  assert.deepStrictEqual(out, { token: '222:bbb', secret: 'env' });
});

test('нет ни файла, ни ENV — пустые строки, без исключения', () => {
  const out = loadBuildSecrets({
    requireFn: () => { throw new Error('missing'); },
    env: {},
  });
  assert.deepStrictEqual(out, { token: '', secret: '' });
});

test('пустой вшитый токен не перекрывает ENV', () => {
  const out = loadBuildSecrets({
    requireFn: () => ({ TELEGRAM_BOT_TOKEN: '', PAIRING_SECRET: '' }),
    env: { TELEGRAM_BOT_TOKEN: '222:bbb', TELEGRAM_SECRET: 'env' },
  });
  assert.deepStrictEqual(out, { token: '222:bbb', secret: 'env' });
});
