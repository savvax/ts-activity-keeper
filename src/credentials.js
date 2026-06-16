const fs = require('fs');
const { safeStorage } = require('electron');
const { readConfig, writeConfig } = require('./config-store');
const { configPath } = require('./paths');

function loadSaved() {
    const j = readConfig(configPath());
    let password = '';
    if (j.enc && j.password) {
        try {
            password = safeStorage.decryptString(Buffer.from(j.password, 'base64'));
        } catch (e) {
            password = '';
        }
    } else {
        password = j.password || '';
    }
    return { email: j.email || '', password };
}

function save(email, password) {
    const patch = { email: email || '' };
    if (password && safeStorage.isEncryptionAvailable()) {
        patch.enc = true;
        patch.password = safeStorage.encryptString(password).toString('base64');
    } else {
        patch.enc = false;
        patch.password = password || '';
    }
    writeConfig(configPath(), patch); // merge — keeps settings keys intact
}

function clear() {
    // Drop credential keys but preserve everything else (e.g. settings).
    const cfg = readConfig(configPath());
    delete cfg.email;
    delete cfg.password;
    delete cfg.enc;
    try {
        fs.writeFileSync(configPath(), JSON.stringify(cfg), { mode: 0o600 });
    } catch (e) {}
}

module.exports = { configPath, loadSaved, save, clear };
