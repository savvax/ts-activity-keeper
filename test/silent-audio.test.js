const { test } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const {
	createSilentAudio,
	buildSilentWav,
	DEFAULT_SECONDS,
	DEFAULT_SAMPLE_RATE,
} = require("../src/silent-audio");

function fakeChild() {
	const c = new EventEmitter();
	c.killed = false;
	c.kill = () => {
		c.killed = true;
	};
	return c;
}

test("buildSilentWav: корректный заголовок 16-bit mono PCM", () => {
	const wav = buildSilentWav(1, 8000); // 1 c @ 8 кГц
	assert.strictEqual(wav.toString("ascii", 0, 4), "RIFF");
	assert.strictEqual(wav.toString("ascii", 8, 12), "WAVE");
	assert.strictEqual(wav.toString("ascii", 12, 16), "fmt ");
	assert.strictEqual(wav.readUInt32LE(16), 16); // fmt size
	assert.strictEqual(wav.readUInt16LE(20), 1); // PCM
	assert.strictEqual(wav.readUInt16LE(22), 1); // mono
	assert.strictEqual(wav.readUInt32LE(24), 8000); // sample rate
	assert.strictEqual(wav.readUInt16LE(32), 2); // block align
	assert.strictEqual(wav.readUInt16LE(34), 16); // bits
	assert.strictEqual(wav.toString("ascii", 36, 40), "data");
	assert.strictEqual(wav.readUInt32LE(40), 8000 * 1 * 2); // data size
});

test("buildSilentWav: сигнал ненулевой, но низкой амплитуды", () => {
	const wav = buildSilentWav(1, 8000);
	let max = 0;
	for (let i = 44; i < wav.length; i += 2) {
		const v = wav.readInt16LE(i);
		if (Math.abs(v) > max) max = Math.abs(v);
	}
	assert.ok(max > 0, "не цифровой ноль — детектор «активного потока» увидит");
	assert.ok(max <= 32767, "в пределах 16-бит");
});

test("start: запускает afplay с переданным wavPath", () => {
	const children = [];
	const sa = createSilentAudio({
		spawn: (cmd, args) => {
			const c = fakeChild();
			children.push({ cmd, args, c });
			return c;
		},
		wavPath: "/repo/resources/silence.wav",
		setTimeoutFn: () => 0,
		clearTimeoutFn: () => {},
	});
	assert.strictEqual(sa.start(), true);
	assert.strictEqual(children.length, 1);
	assert.strictEqual(children[0].cmd, "afplay");
	assert.deepStrictEqual(children[0].args, [
		"-q",
		"/repo/resources/silence.wav",
	]);
	assert.strictEqual(sa.isActive(), true);
});

test("без wavPath start возвращает false и afplay не запускается", () => {
	const children = [];
	const sa = createSilentAudio({
		spawn: () => {
			const c = fakeChild();
			children.push(c);
			return c;
		},
		setTimeoutFn: () => 0,
		clearTimeoutFn: () => {},
	});
	assert.strictEqual(sa.start(), false);
	assert.strictEqual(children.length, 0);
});

test("выход afplay → перепланирование, watchdog → повторный spawn", () => {
	const children = [];
	let tickFn = null;
	const sa = createSilentAudio({
		spawn: () => {
			const c = fakeChild();
			children.push(c);
			return c;
		},
		wavPath: "/x.wav",
		setTimeoutFn: (fn) => {
			tickFn = fn;
			return 1;
		},
		clearTimeoutFn: () => {},
	});
	sa.start();
	assert.strictEqual(children.length, 1);
	assert.strictEqual(sa.isActive(), true);

	children[0].emit("exit"); // afplay закончил играть
	assert.strictEqual(sa.isActive(), false);
	assert.strictEqual(typeof tickFn, "function");
	tickFn();
	assert.strictEqual(children.length, 2); // перезапустился
	assert.strictEqual(sa.isActive(), true);
});

test("stop: убивает активный afplay", () => {
	const children = [];
	const sa = createSilentAudio({
		spawn: () => {
			const c = fakeChild();
			children.push(c);
			return c;
		},
		wavPath: "/x.wav",
		setTimeoutFn: () => 0,
		clearTimeoutFn: () => {},
	});
	sa.start();
	assert.strictEqual(sa.isActive(), true);
	sa.stop();
	assert.strictEqual(children[0].killed, true);
	assert.strictEqual(sa.isActive(), false);
	sa.stop(); // повторный stop безопасен
});

test("stop: отменяет запланированный перезапуск", () => {
	const children = [];
	let tickFn = null;
	let cleared = 0;
	const sa = createSilentAudio({
		spawn: () => {
			const c = fakeChild();
			children.push(c);
			return c;
		},
		wavPath: "/x.wav",
		setTimeoutFn: (fn) => {
			tickFn = fn;
			return 1;
		},
		clearTimeoutFn: () => {
			cleared++;
		},
	});
	sa.start();
	children[0].emit("exit"); // запланирован watchdog
	assert.strictEqual(typeof tickFn, "function");
	sa.stop();
	assert.ok(cleared >= 1, "watchdog снят");
	tickFn && tickFn(); // даже если сработает — stopping=true, спавна не будет
	assert.strictEqual(children.length, 1, "нет повторного spawn после stop");
});

test("повторный start когда уже крутится — без второго spawn", () => {
	const children = [];
	const sa = createSilentAudio({
		spawn: () => {
			const c = fakeChild();
			children.push(c);
			return c;
		},
		wavPath: "/x.wav",
		setTimeoutFn: () => 0,
		clearTimeoutFn: () => {},
	});
	sa.start();
	sa.start(); // уже активен — не плодим процессы
	assert.strictEqual(children.length, 1);
});

test("после stop можно снова start", () => {
	const children = [];
	const sa = createSilentAudio({
		spawn: () => {
			const c = fakeChild();
			children.push(c);
			return c;
		},
		wavPath: "/x.wav",
		setTimeoutFn: () => 0,
		clearTimeoutFn: () => {},
	});
	sa.start();
	sa.stop();
	sa.start();
	assert.strictEqual(children.length, 2);
	assert.strictEqual(sa.isActive(), true);
});

test("дефолты sane", () => {
	assert.strictEqual(DEFAULT_SECONDS, 60);
	assert.strictEqual(DEFAULT_SAMPLE_RATE, 8000);
});
