const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseCommand, parseLogin, parseAutostop, parseRemind, parseToggle,
} = require('../src/commands');

test('parseCommand: имя команды нормализуется, аргументы отделяются', () => {
  assert.deepStrictEqual(parseCommand('/Status@MyBot'), { cmd: '/status', args: [] });
  assert.deepStrictEqual(parseCommand('  /autostop  90   logout '), {
    cmd: '/autostop', args: ['90', 'logout'],
  });
});

test('parseCommand: не-команды и мусор дают null', () => {
  assert.strictEqual(parseCommand('привет'), null);
  assert.strictEqual(parseCommand(''), null);
  assert.strictEqual(parseCommand(undefined), null);
  assert.strictEqual(parseCommand(42), null);
});

test('parseLogin: email и пароль', () => {
  assert.deepStrictEqual(parseLogin(['a@b.c', 'secret']), {
    ok: true, email: 'a@b.c', password: 'secret',
  });
});

test('parseLogin: пароль с пробелами склеивается', () => {
  const r = parseLogin(['a@b.c', 'two', 'words']);
  assert.strictEqual(r.password, 'two words');
});

test('parseLogin: мало аргументов или не email', () => {
  assert.strictEqual(parseLogin(['a@b.c']).ok, false);
  assert.strictEqual(parseLogin([]).ok, false);
  const r = parseLogin(['notanemail', 'pw']);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /email/i);
});

test('parseAutostop: минуты и флаг logout', () => {
  assert.deepStrictEqual(parseAutostop(['90']), { ok: true, minutes: 90, logout: false });
  assert.deepStrictEqual(parseAutostop(['90', 'logout']), { ok: true, minutes: 90, logout: true });
});

test('parseAutostop: off и 0 выключают', () => {
  assert.deepStrictEqual(parseAutostop(['off']), { ok: true, minutes: 0, logout: false });
  assert.deepStrictEqual(parseAutostop(['0']), { ok: true, minutes: 0, logout: false });
});

test('parseAutostop: мусор и пустой ввод отклоняются', () => {
  assert.strictEqual(parseAutostop([]).ok, false);
  assert.strictEqual(parseAutostop(['abc']).ok, false);
  assert.strictEqual(parseAutostop(['-5']).ok, false);
});

test('parseRemind: минуты, off и мусор', () => {
  assert.deepStrictEqual(parseRemind(['15']), { ok: true, minutes: 15 });
  assert.deepStrictEqual(parseRemind(['off']), { ok: true, minutes: 0 });
  assert.deepStrictEqual(parseRemind(['0']), { ok: true, minutes: 0 });
  assert.strictEqual(parseRemind(['abc']).ok, false);
  assert.strictEqual(parseRemind([]).ok, false);
});

test('parseToggle: on/off регистронезависимо, остальное отклоняется', () => {
  assert.deepStrictEqual(parseToggle(['ON']), { ok: true, on: true });
  assert.deepStrictEqual(parseToggle(['off']), { ok: true, on: false });
  assert.strictEqual(parseToggle([]).ok, false);
  assert.strictEqual(parseToggle(['maybe']).ok, false);
});
