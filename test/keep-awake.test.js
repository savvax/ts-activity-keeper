const { test } = require("node:test");
const assert = require("node:assert");
const {
	createKeepAwake,
	KEEP_AWAKE_MODE,
	DEFAULT_NUDGE_INTERVAL_MS,
} = require("../src/keep-awake");

function fakeBlocker(opts = {}) {
	const started = new Set();
	const modes = [];
	let nextId = 1;
	return {
		modes,
		started,
		start(mode) {
			if (opts.throwOnStart) throw new Error("no power management");
			modes.push(mode);
			const id = nextId++;
			started.add(id);
			return id;
		},
		stop(id) {
			started.delete(id);
		},
		isStarted(id) {
			return started.has(id);
		},
	};
}

test("start включает блокировку в режиме prevent-display-sleep", () => {
	const blocker = fakeBlocker();
	const ka = createKeepAwake({ blocker });
	assert.strictEqual(ka.start(), true);
	assert.deepStrictEqual(blocker.modes, [KEEP_AWAKE_MODE]);
	assert.strictEqual(KEEP_AWAKE_MODE, "prevent-display-sleep");
	assert.strictEqual(ka.isActive(), true);
});

test("повторный start идемпотентен — второй блокировщик не заводится", () => {
	const blocker = fakeBlocker();
	const ka = createKeepAwake({ blocker });
	ka.start();
	ka.start();
	ka.start();
	assert.strictEqual(blocker.modes.length, 1);
	assert.strictEqual(blocker.started.size, 1);
});

test("stop снимает блокировку и повторный stop безопасен", () => {
	const blocker = fakeBlocker();
	const ka = createKeepAwake({ blocker });
	ka.start();
	ka.stop();
	assert.strictEqual(blocker.started.size, 0);
	assert.strictEqual(ka.isActive(), false);
	ka.stop();
	assert.strictEqual(ka.isActive(), false);
});

test("после stop можно снова start", () => {
	const blocker = fakeBlocker();
	const ka = createKeepAwake({ blocker });
	ka.start();
	ka.stop();
	ka.start();
	assert.strictEqual(blocker.modes.length, 2);
	assert.strictEqual(ka.isActive(), true);
});

test("исключение блокировщика не роняет приложение", () => {
	const logged = [];
	const ka = createKeepAwake({
		blocker: fakeBlocker({ throwOnStart: true }),
		log: (m) => logged.push(m),
	});
	assert.strictEqual(ka.start(), false);
	assert.strictEqual(ka.isActive(), false);
	assert.strictEqual(logged.length, 1);
});

// Контролируемые таймеры: keep-awake использует не более одного nudge-таймера,
// поэтому хватит одного слота.
function fakeClock() {
	let handle = null;
	return {
		setIntervalFn: (fn, ms) => {
			handle = { fn, ms, cleared: false };
			return handle;
		},
		clearIntervalFn: (h) => {
			if (handle === h) handle.cleared = true;
		},
		tick() {
			if (handle && !handle.cleared) handle.fn();
		},
		get ms() {
			return handle ? handle.ms : null;
		},
		get installed() {
			return !!handle && !handle.cleared;
		},
		get cleared() {
			return !handle || handle.cleared;
		},
	};
}

test("дефолтный интервал nudge — 60 c", () => {
	assert.strictEqual(DEFAULT_NUDGE_INTERVAL_MS, 60_000);
});

test("start сразу дёргает nudge и ставит его на интервал", async () => {
	const blocker = fakeBlocker();
	const calls = [];
	const clock = fakeClock();
	const ka = createKeepAwake({
		blocker,
		nudge: () => {
			calls.push(1);
			return Promise.resolve();
		},
		nudgeIntervalMs: 12345,
		setIntervalFn: clock.setIntervalFn,
		clearIntervalFn: clock.clearIntervalFn,
	});
	assert.strictEqual(ka.start(), true);
	await new Promise((r) => setImmediate(r)); // fireNudge асинхронен
	assert.strictEqual(calls.length, 1, "немедленный тычок при старте");
	assert.strictEqual(clock.ms, 12345);
	assert.strictEqual(ka.isNudging(), true);
	clock.tick();
	await new Promise((r) => setImmediate(r));
	assert.strictEqual(calls.length, 2, "тик таймера вызывает nudge");
});

test("без nudge таймер не ставится (обратная совместимость)", () => {
	const blocker = fakeBlocker();
	let timerSet = false;
	const ka = createKeepAwake({
		blocker,
		setIntervalFn: () => {
			timerSet = true;
			return 1;
		},
		clearIntervalFn: () => {},
	});
	ka.start();
	assert.strictEqual(timerSet, false);
	assert.strictEqual(ka.isNudging(), false);
});

test("stop снимает nudge-таймер", () => {
	const blocker = fakeBlocker();
	const clock = fakeClock();
	const ka = createKeepAwake({
		blocker,
		nudge: () => Promise.resolve(),
		setIntervalFn: clock.setIntervalFn,
		clearIntervalFn: clock.clearIntervalFn,
	});
	ka.start();
	assert.strictEqual(clock.installed, true);
	ka.stop();
	assert.strictEqual(clock.cleared, true);
	assert.strictEqual(ka.isNudging(), false);
});

test("после stop nudge снова заводится при повторном start", () => {
	const blocker = fakeBlocker();
	const clock = fakeClock();
	const ka = createKeepAwake({
		blocker,
		nudge: () => Promise.resolve(),
		setIntervalFn: clock.setIntervalFn,
		clearIntervalFn: clock.clearIntervalFn,
	});
	ka.start();
	ka.stop();
	assert.strictEqual(clock.installed, false);
	ka.start();
	assert.strictEqual(clock.installed, true);
	assert.strictEqual(ka.isNudging(), true);
});

test("ошибка nudge логируется, но не роняет keep-awake", async () => {
	const blocker = fakeBlocker();
	const logged = [];
	const clock = fakeClock();
	const ka = createKeepAwake({
		blocker,
		log: (m) => logged.push(m),
		nudge: () => Promise.reject(new Error("boom")),
		setIntervalFn: clock.setIntervalFn,
		clearIntervalFn: clock.clearIntervalFn,
	});
	ka.start();
	await new Promise((r) => setImmediate(r)); // дать промисам доделать
	clock.tick();
	await new Promise((r) => setImmediate(r));
	assert.ok(
		logged.some((m) => m.includes("nudge") && m.includes("boom")),
		"ошибка попала в лог",
	);
	assert.strictEqual(ka.isActive(), true); // блокировка сна жива
});
