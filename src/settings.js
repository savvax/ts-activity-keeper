const { readConfig, writeConfig } = require('./config-store');
const { configPath } = require('./paths');

const DEFAULTS = {
    notifyReminderMinutes: 5,
    notifySound: true,
    hideLogin: false,
    autoStopMinutes: 0,      // 0 = auto-stop disabled
    autoStopLogout: false,   // when auto-stop fires: also log out
    telegramToken: '',
    telegramChatId: '',
};

function withDefaults(cfg) {
    cfg = cfg || {};
    const out = {};
    for (const key of Object.keys(DEFAULTS)) {
        out[key] = cfg[key] != null ? cfg[key] : DEFAULTS[key];
    }
    return out;
}

// Returns a patch with only the provided, validated keys.
function sanitize(patch) {
    patch = patch || {};
    const out = {};
    if (patch.notifyReminderMinutes != null) {
        const n = parseInt(patch.notifyReminderMinutes, 10);
        out.notifyReminderMinutes = Number.isFinite(n) ? Math.max(1, n) : DEFAULTS.notifyReminderMinutes;
    }
    if (patch.notifySound != null) out.notifySound = !!patch.notifySound;
    // hideLogin is one-way: only `true` is ever accepted into a patch. Turning
    // it back off is enforced impossible here (and additionally in saveSettings).
    if (patch.hideLogin === true) out.hideLogin = true;
    if (patch.autoStopMinutes != null) {
        const n = parseInt(patch.autoStopMinutes, 10);
        out.autoStopMinutes = Number.isFinite(n) ? Math.max(0, n) : DEFAULTS.autoStopMinutes;
    }
    if (patch.autoStopLogout != null) out.autoStopLogout = !!patch.autoStopLogout;
    if (patch.telegramToken != null) out.telegramToken = String(patch.telegramToken).trim();
    if (patch.telegramChatId != null) out.telegramChatId = String(patch.telegramChatId).trim();
    return out;
}

function loadSettings() {
    return withDefaults(readConfig(configPath()));
}

function saveSettings(patch) {
    writeConfig(configPath(), sanitize(patch));
    return loadSettings();
}

module.exports = { DEFAULTS, withDefaults, sanitize, configPath, loadSettings, saveSettings };
