const { test } = require('node:test');
const assert = require('node:assert');
const { createKeepAwake, KEEP_AWAKE_MODE } = require('../src/keep-awake');

function fakeBlocker(opts = {}) {
  const started = new Set();
  const modes = [];
  let nextId = 1;
  return {
    modes,
    started,
    start(mode) {
      if (opts.throwOnStart) throw new Error('no power management');
      modes.push(mode);
      const id = nextId++;
      started.add(id);
      return id;
    },
    stop(id) { started.delete(id); },
    isStarted(id) { return started.has(id); },
  };
}

test('start включает блокировку в режиме prevent-display-sleep', () => {
  const blocker = fakeBlocker();
  const ka = createKeepAwake({ blocker });
  assert.strictEqual(ka.start(), true);
  assert.deepStrictEqual(blocker.modes, [KEEP_AWAKE_MODE]);
  assert.strictEqual(KEEP_AWAKE_MODE, 'prevent-display-sleep');
  assert.strictEqual(ka.isActive(), true);
});

test('повторный start идемпотентен — второй блокировщик не заводится', () => {
  const blocker = fakeBlocker();
  const ka = createKeepAwake({ blocker });
  ka.start();
  ka.start();
  ka.start();
  assert.strictEqual(blocker.modes.length, 1);
  assert.strictEqual(blocker.started.size, 1);
});

test('stop снимает блокировку и повторный stop безопасен', () => {
  const blocker = fakeBlocker();
  const ka = createKeepAwake({ blocker });
  ka.start();
  ka.stop();
  assert.strictEqual(blocker.started.size, 0);
  assert.strictEqual(ka.isActive(), false);
  ka.stop();
  assert.strictEqual(ka.isActive(), false);
});

test('после stop можно снова start', () => {
  const blocker = fakeBlocker();
  const ka = createKeepAwake({ blocker });
  ka.start();
  ka.stop();
  ka.start();
  assert.strictEqual(blocker.modes.length, 2);
  assert.strictEqual(ka.isActive(), true);
});

test('исключение блокировщика не роняет приложение', () => {
  const logged = [];
  const ka = createKeepAwake({
    blocker: fakeBlocker({ throwOnStart: true }),
    log: (m) => logged.push(m),
  });
  assert.strictEqual(ka.start(), false);
  assert.strictEqual(ka.isActive(), false);
  assert.strictEqual(logged.length, 1);
});
