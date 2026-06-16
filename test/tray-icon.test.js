const { test } = require('node:test');
const assert = require('node:assert');
const { STATUS_COLORS } = require('../src/tray-icon');

test('notcounting color exists and differs from running and error', () => {
  assert.ok(STATUS_COLORS.notcounting, 'notcounting key present');
  assert.deepStrictEqual(STATUS_COLORS.notcounting.face, [255, 138, 0]);
  assert.notDeepStrictEqual(STATUS_COLORS.notcounting.face, STATUS_COLORS.running.face);
  assert.notDeepStrictEqual(STATUS_COLORS.notcounting.face, STATUS_COLORS.error.face);
});
