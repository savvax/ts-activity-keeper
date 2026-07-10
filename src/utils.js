/**
 * Utilities for TS Activity Keeper
 */

const crypto = require('crypto');

function randomDelay(min, max) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max) {
    return Math.random() * (max - min) + min;
}

function formatDuration(ms) {
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor((ms / (1000 * 60 * 60)));

    const pad = (num) => num.toString().padStart(2, '0');
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function formatSeconds(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds || 0));
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const seconds = s % 60;

    const pad = (num) => num.toString().padStart(2, '0');
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function generateFingerprint(deviceId) {
    return crypto.createHash('md5')
        .update(`${deviceId}-${process.platform}-${process.arch}`)
        .digest('hex');
}

// Privacy mask for the account login: keeps the first two characters of the
// local part and the first character of the domain ("jd•••@g•••").
function maskLogin(login) {
    if (!login) return '';
    const at = login.indexOf('@');
    const local = at >= 0 ? login.slice(0, at) : login;
    const domain = at >= 0 ? login.slice(at + 1) : '';
    const head = local.slice(0, Math.min(2, Math.max(1, local.length - 1)));
    const masked = `${head}•••`;
    return domain ? `${masked}@${domain.slice(0, 1)}•••` : masked;
}

module.exports = {
    randomDelay,
    randomInt,
    randomFloat,
    formatDuration,
    formatSeconds,
    generateFingerprint,
    maskLogin
};
