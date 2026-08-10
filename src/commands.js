// Чистый разбор Telegram-команд и их аргументов. Никаких сетевых и
// Electron-зависимостей — только строки, чтобы всё покрывалось юнит-тестами.

// '/Autostop@MyBot 90 logout' -> { cmd: '/autostop', args: ['90', 'logout'] }
function parseCommand(text) {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return null;
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].split('@')[0].toLowerCase();
    return { cmd, args: parts.slice(1) };
}

function parseLogin(args) {
    if (!args || args.length < 2) {
        return { ok: false, error: 'Формат: /login <email> <пароль>' };
    }
    const email = args[0];
    // Пароль может содержать пробелы — забираем весь остаток строки.
    const password = args.slice(1).join(' ');
    if (!email.includes('@')) {
        return { ok: false, error: 'Первым аргументом ожидается email. Формат: /login <email> <пароль>' };
    }
    return { ok: true, email, password };
}

function parseAutostop(args) {
    const usage = 'Формат: /autostop <минуты> [logout] или /autostop off';
    if (!args || !args.length) return { ok: false, error: usage };
    const first = args[0].toLowerCase();
    if (first === 'off' || first === '0') return { ok: true, minutes: 0, logout: false };
    const minutes = parseInt(first, 10);
    if (!Number.isFinite(minutes) || minutes <= 0) return { ok: false, error: usage };
    const logout = args.slice(1).some((a) => a.toLowerCase() === 'logout');
    return { ok: true, minutes, logout };
}

function parseRemind(args) {
    const usage = 'Формат: /remind <минуты> или /remind off';
    if (!args || !args.length) return { ok: false, error: usage };
    const first = args[0].toLowerCase();
    if (first === 'off' || first === '0') return { ok: true, minutes: 0 };
    const minutes = parseInt(first, 10);
    if (!Number.isFinite(minutes) || minutes <= 0) return { ok: false, error: usage };
    return { ok: true, minutes };
}

function parseToggle(args) {
    const value = ((args && args[0]) || '').toLowerCase();
    if (value === 'on') return { ok: true, on: true };
    if (value === 'off') return { ok: true, on: false };
    return { ok: false, error: 'Формат: on или off' };
}

module.exports = { parseCommand, parseLogin, parseAutostop, parseRemind, parseToggle };
