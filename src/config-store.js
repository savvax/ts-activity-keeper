// Read-modify-write a JSON config file so independent writers (credentials,
// settings) don't clobber each other's keys. fs only — unit-testable.
const fs = require('fs');

function readConfig(filePath) {
    try {
        const obj = JSON.parse(fs.readFileSync(filePath, 'utf8') || '{}');
        return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch (e) {
        return {};
    }
}

function writeConfig(filePath, patch) {
    const merged = { ...readConfig(filePath), ...patch };
    fs.writeFileSync(filePath, JSON.stringify(merged), { mode: 0o600 });
    return merged;
}

module.exports = { readConfig, writeConfig };
