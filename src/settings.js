const { readConfig, writeConfig } = require('./config-store');
const { configPath } = require('./paths');

const VALID_MODES = ['window', 'background', 'api'];
const DEFAULTS = { notifyReminderMinutes: 5, notifySound: true, mode: 'api' };

function withDefaults(cfg) {
    cfg = cfg || {};
    return {
        notifyReminderMinutes: cfg.notifyReminderMinutes != null ? cfg.notifyReminderMinutes : DEFAULTS.notifyReminderMinutes,
        notifySound: cfg.notifySound != null ? cfg.notifySound : DEFAULTS.notifySound,
        mode: VALID_MODES.includes(cfg.mode) ? cfg.mode : DEFAULTS.mode,
    };
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
    if (patch.mode != null) out.mode = VALID_MODES.includes(patch.mode) ? patch.mode : DEFAULTS.mode;
    return out;
}

function loadSettings() {
    return withDefaults(readConfig(configPath()));
}

function saveSettings(patch) {
    writeConfig(configPath(), sanitize(patch));
    return loadSettings();
}

module.exports = { DEFAULTS, VALID_MODES, withDefaults, sanitize, configPath, loadSettings, saveSettings };
