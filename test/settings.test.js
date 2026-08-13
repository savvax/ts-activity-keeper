const { test } = require("node:test");
const assert = require("node:assert");
const { DEFAULTS, withDefaults, sanitize } = require("../src/settings");

test("DEFAULTS содержит только актуальные ключи", () => {
	assert.deepStrictEqual(Object.keys(DEFAULTS).sort(), [
		"audioKeepAlive",
		"autoStopLogout",
		"autoStopMinutes",
		"autostart",
		"hideLogin",
		"remindMinutes",
		"telegramChatId",
	]);
	assert.strictEqual(DEFAULTS.remindMinutes, 5);
	assert.strictEqual(DEFAULTS.autostart, true);
});

test("withDefaults подставляет умолчания и сохраняет заданные значения", () => {
	const out = withDefaults({ remindMinutes: 15 });
	assert.strictEqual(out.remindMinutes, 15);
	assert.strictEqual(out.autoStopMinutes, 0);
	assert.strictEqual(out.telegramChatId, "");
});

test("withDefaults игнорирует удалённые ключи", () => {
	const out = withDefaults({ notifySound: false, telegramToken: "x" });
	assert.strictEqual(out.notifySound, undefined);
	assert.strictEqual(out.telegramToken, undefined);
});

test("sanitize возвращает только переданные ключи", () => {
	assert.deepStrictEqual(sanitize({ autostart: false }), { autostart: false });
	assert.deepStrictEqual(sanitize({}), {});
});

test("sanitize: remindMinutes — неотрицательное целое, 0 разрешён", () => {
	assert.strictEqual(sanitize({ remindMinutes: "15" }).remindMinutes, 15);
	assert.strictEqual(sanitize({ remindMinutes: 0 }).remindMinutes, 0);
	assert.strictEqual(sanitize({ remindMinutes: -3 }).remindMinutes, 0);
	assert.strictEqual(sanitize({ remindMinutes: "abc" }).remindMinutes, 5);
});

test("sanitize: autoStopMinutes не бывает отрицательным", () => {
	assert.strictEqual(sanitize({ autoStopMinutes: "90" }).autoStopMinutes, 90);
	assert.strictEqual(sanitize({ autoStopMinutes: -5 }).autoStopMinutes, 0);
});

test("sanitize: hideLogin односторонний — false отбрасывается", () => {
	assert.deepStrictEqual(sanitize({ hideLogin: true }), { hideLogin: true });
	assert.deepStrictEqual(sanitize({ hideLogin: false }), {});
});

test("sanitize: autostart приводится к boolean", () => {
	assert.strictEqual(sanitize({ autostart: "on" }).autostart, true);
	assert.strictEqual(sanitize({ autostart: false }).autostart, false);
});

test("sanitize: audioKeepAlive приводится к boolean", () => {
	assert.strictEqual(sanitize({ audioKeepAlive: "on" }).audioKeepAlive, true);
	assert.strictEqual(sanitize({ audioKeepAlive: false }).audioKeepAlive, false);
});

test("sanitize: telegramChatId тримится, telegramToken больше не принимается", () => {
	assert.strictEqual(
		sanitize({ telegramChatId: " 555 " }).telegramChatId,
		"555",
	);
	assert.strictEqual(
		sanitize({ telegramToken: "abc" }).telegramToken,
		undefined,
	);
});
