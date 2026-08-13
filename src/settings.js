const { readConfig, writeConfig } = require("./config-store");
const { configPath } = require("./paths");

const DEFAULTS = {
	hideLogin: false,
	autoStopMinutes: 0, // 0 = автостоп выключен
	autoStopLogout: false, // при срабатывании автостопа ещё и разлогинить
	remindMinutes: 5, // повтор «время не считается»; 0 = без повторов
	autostart: true, // прописывать себя в объекты входа
	audioKeepAlive: true, // крутить почти бесшумный afplay (анти-idle)
	telegramChatId: "",
};

function withDefaults(cfg) {
	cfg = cfg || {};
	const out = {};
	for (const key of Object.keys(DEFAULTS)) {
		out[key] = cfg[key] != null ? cfg[key] : DEFAULTS[key];
	}
	return out;
}

// Возвращает патч только из переданных и провалидированных ключей.
function sanitize(patch) {
	patch = patch || {};
	const out = {};
	// hideLogin односторонний: в патч попадает только `true`.
	if (patch.hideLogin === true) out.hideLogin = true;
	if (patch.autoStopMinutes != null) {
		const n = parseInt(patch.autoStopMinutes, 10);
		out.autoStopMinutes = Number.isFinite(n)
			? Math.max(0, n)
			: DEFAULTS.autoStopMinutes;
	}
	if (patch.autoStopLogout != null) out.autoStopLogout = !!patch.autoStopLogout;
	if (patch.remindMinutes != null) {
		const n = parseInt(patch.remindMinutes, 10);
		out.remindMinutes = Number.isFinite(n)
			? Math.max(0, n)
			: DEFAULTS.remindMinutes;
	}
	if (patch.autostart != null) out.autostart = !!patch.autostart;
	if (patch.audioKeepAlive != null) out.audioKeepAlive = !!patch.audioKeepAlive;
	if (patch.telegramChatId != null)
		out.telegramChatId = String(patch.telegramChatId).trim();
	return out;
}

function loadSettings() {
	return withDefaults(readConfig(configPath()));
}

function saveSettings(patch) {
	writeConfig(configPath(), sanitize(patch));
	return loadSettings();
}

module.exports = {
	DEFAULTS,
	withDefaults,
	sanitize,
	configPath,
	loadSettings,
	saveSettings,
};
