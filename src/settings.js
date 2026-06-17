const { readConfig, writeConfig } = require('./config-store');
const { configPath } = require('./paths');

const DEFAULTS = { notifyReminderMinutes: 5, notifySound: true };

function withDefaults(cfg) {
    cfg = cfg || {};
    return {
        notifyReminderMinutes: cfg.notifyReminderMinutes != null ? cfg.notifyReminderMinutes : DEFAULTS.notifyReminderMinutes,
        notifySound: cfg.notifySound != null ? cfg.notifySound : DEFAULTS.notifySound,
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
