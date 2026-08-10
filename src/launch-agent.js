// Попытка прописать приложение в объекты входа macOS.
// setLoginItemSettings ничего не возвращает и может молча не сработать,
// поэтому результат всегда проверяется повторным чтением настройки.
// `app` инжектится, чтобы модуль тестировался без Electron.

// Пути, из которых автозапуск бесполезен: App Translocation монтирует .app
// во временный каталог, а запуск из ~/Downloads регистрирует путь, который
// пользователь почти наверняка сломает переносом.
const TRANSLOCATION_MARKERS = ['/private/var/folders/', '/AppTranslocation/'];

function isBadLocation(exePath) {
    if (!exePath) return false;
    if (TRANSLOCATION_MARKERS.some((marker) => exePath.includes(marker))) return true;
    return !exePath.startsWith('/Applications/');
}

function readOpenAtLogin(app) {
    try {
        return !!app.getLoginItemSettings().openAtLogin;
    } catch (e) {
        return false;
    }
}

function ensureAutostart({ app, desired, packaged }) {
    if (!desired) {
        try {
            app.setLoginItemSettings({ openAtLogin: false });
        } catch (e) {
            // выключение не критично — сообщать не о чем
        }
        return { desired: false, actual: readOpenAtLogin(app), ok: true, reason: 'disabled' };
    }

    const isPackaged = packaged != null ? packaged : !!app.isPackaged;
    if (isPackaged && isBadLocation(app.getPath('exe'))) {
        return { desired: true, actual: readOpenAtLogin(app), ok: false, reason: 'location' };
    }

    if (readOpenAtLogin(app)) {
        return { desired: true, actual: true, ok: true, reason: 'already' };
    }

    try {
        app.setLoginItemSettings({ openAtLogin: true });
    } catch (e) {
        return { desired: true, actual: false, ok: false, reason: 'denied' };
    }

    const actual = readOpenAtLogin(app);
    return { desired: true, actual, ok: actual, reason: actual ? 'set' : 'denied' };
}

function describeAutostart(result) {
    if (!result) return 'неизвестно';
    if (result.reason === 'dev') return 'не трогаем (запущено не из собранного .app)';
    if (result.desired === false) return 'выкл';
    if (result.ok) return 'включён';
    if (result.reason === 'location') {
        return 'не удалось включить — приложение запущено не из /Applications; '
            + 'перетащи его в /Applications и запусти оттуда';
    }
    return 'не удалось включить — система не дала прописать автозапуск; '
        + 'разреши приложение в Системных настройках → Основные → Объекты входа';
}

module.exports = { ensureAutostart, describeAutostart, isBadLocation };
