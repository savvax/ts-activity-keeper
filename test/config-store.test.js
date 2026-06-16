const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readConfig, writeConfig } = require('../src/config-store');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'config.json');
}

test('readConfig returns {} for missing file', () => {
  assert.deepStrictEqual(readConfig(path.join(os.tmpdir(), 'does-not-exist-xyz.json')), {});
});

test('readConfig returns {} for corrupt JSON', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{not json');
  assert.deepStrictEqual(readConfig(f), {});
});

test('readConfig returns {} for a JSON array file', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '[1,2,3]');
  assert.deepStrictEqual(readConfig(f), {});
});

test('writeConfig patch value wins over stored value', () => {
  const f = tmpFile();
  writeConfig(f, { email: 'old@x.com' });
  writeConfig(f, { email: 'new@x.com' });
  assert.strictEqual(readConfig(f).email, 'new@x.com');
});

test('writeConfig merges instead of clobbering', () => {
  const f = tmpFile();
  writeConfig(f, { email: 'a@b.c', password: 'secret' });
  writeConfig(f, { notifyReminderMinutes: 7 });
  const out = readConfig(f);
  assert.strictEqual(out.email, 'a@b.c');
  assert.strictEqual(out.password, 'secret');
  assert.strictEqual(out.notifyReminderMinutes, 7);
});
