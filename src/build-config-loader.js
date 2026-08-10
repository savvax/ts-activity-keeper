// Читает секреты, вшитые при сборке в src/build-config.js.
// Файл в .gitignore и в dev-окружении отсутствует — тогда значения берутся
// из ENV (.env подхватывается dotenv в main.js), а их отсутствие не ошибка:
// приложение просто работает как трекер без remote control.

function loadBuildSecrets({ requireFn, env } = {}) {
    const load = requireFn || ((id) => require(id));
    let baked = {};
    try {
        baked = load('./build-config') || {};
    } catch (e) {
        baked = {};
    }
    const environment = env || process.env;
    const pick = (a, b) => String(a || b || '').trim();
    return {
        token: pick(baked.TELEGRAM_BOT_TOKEN, environment.TELEGRAM_BOT_TOKEN),
        secret: pick(baked.PAIRING_SECRET, environment.TELEGRAM_SECRET),
    };
}

module.exports = { loadBuildSecrets };
