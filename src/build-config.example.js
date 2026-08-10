// Шаблон вшиваемых при сборке секретов.
// Реальный src/build-config.js генерится скриптом build/prepare-secrets.js
// на `npm run build` и НЕ коммитится (см. .gitignore).
module.exports = {
    TELEGRAM_BOT_TOKEN: '',  // токен от @BotFather
    PAIRING_SECRET: '',      // ключ для /start <секрет>
};
