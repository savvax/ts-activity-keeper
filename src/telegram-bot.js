// Telegram remote control: long-polls getUpdates и раздаёт команды в
// инжектированные хендлеры. Без Electron-зависимостей — `request` (axios в
// проде), доступ к токену/ключу/чату и хендлеры инжектятся, поэтому модуль
// тестируется фейками.
//
// Модель безопасности: бот отвечает ровно одному чату. Пока чат не привязан,
// принимается только `/start <ключ>` с ключом, вшитым в сборку; всё остальное
// от непривязанных чатов игнорируется молча. После привязки чужие чаты
// игнорируются молча.

const {
    parseCommand, parseLogin, parseAutostop, parseRemind, parseToggle,
} = require('./commands');

const TELEGRAM_API_BASE = 'https://api.telegram.org';

const HELP = [
    'TS Activity Keeper — управление:',
    '/status — статус, часы за сегодня и неделю',
    '/login <email> <пароль> — войти в аккаунт и запустить трекинг',
    '/logout — выйти из аккаунта (трекинг останавливается)',
    '/pause — остановить трекинг',
    '/resume — запустить трекинг',
    '/autostop <минуты> [logout] — таймер автостопа, /autostop off — выключить',
    '/autostart on|off — автозапуск при входе в macOS',
    '/remind <минуты>|off — как часто напоминать, что время не считается',
    '/hidelogin — маскировать логин в ответах (обратно не выключается)',
    '/quit — выйти из приложения на Маке',
    '/help — это сообщение',
].join('\n');

function createTelegramBot(opts) {
    const request = opts.request;
    const getToken = opts.getToken;
    const getSecret = opts.getSecret || (() => '');
    const getChatId = opts.getChatId;
    const bindChatId = opts.bindChatId;
    const handlers = opts.handlers || {};
    const apiBase = opts.apiBase || TELEGRAM_API_BASE;
    const wait = opts.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const log = opts.log || (() => {});

    let running = false;
    let offset = 0;

    async function api(method, data) {
        const token = getToken();
        if (!token) return null;
        const response = await request({
            method: 'POST',
            url: `${apiBase}/bot${token}/${method}`,
            headers: { 'Content-Type': 'application/json' },
            data,
            timeout: 40000, // > long-poll timeout below
            validateStatus: () => true,
        });
        return response && response.data;
    }

    async function send(chatId, text) {
        if (!chatId) return;
        await api('sendMessage', { chat_id: chatId, text });
    }

    // Каждый хендлер возвращает текст ответа — бот сам его отправляет.
    async function handleCommand(parsed, chatId) {
        const { cmd, args } = parsed;
        switch (cmd) {
            case '/start':
            case '/help':
                return send(chatId, HELP);
            case '/status':
                return send(chatId, await handlers.status());
            case '/login': {
                const p = parseLogin(args);
                if (!p.ok) return send(chatId, p.error);
                return send(chatId, await handlers.login(p.email, p.password));
            }
            case '/logout':
                return send(chatId, await handlers.logout());
            case '/pause':
                return send(chatId, await handlers.pause());
            case '/resume':
                return send(chatId, await handlers.resume());
            case '/autostop': {
                const p = parseAutostop(args);
                if (!p.ok) return send(chatId, p.error);
                return send(chatId, await handlers.autostop(p.minutes, p.logout));
            }
            case '/autostart': {
                const p = parseToggle(args);
                if (!p.ok) return send(chatId, p.error);
                return send(chatId, await handlers.autostart(p.on));
            }
            case '/remind': {
                const p = parseRemind(args);
                if (!p.ok) return send(chatId, p.error);
                return send(chatId, await handlers.remind(p.minutes));
            }
            case '/hidelogin':
                return send(chatId, await handlers.hidelogin());
            case '/quit':
                // Предупреждаем, пока процесс ещё жив.
                await send(chatId, 'Выхожу из приложения. Запустить обратно можно только с Мака.');
                return handlers.quit();
            default:
                return send(chatId, 'Неизвестная команда. /help — список.');
        }
    }

    async function processUpdate(update) {
        const msg = update && update.message;
        if (!msg || !msg.chat || typeof msg.text !== 'string') return;
        const fromChat = String(msg.chat.id);
        const bound = String(getChatId() || '');
        const parsed = parseCommand(msg.text);
        if (!parsed) return;

        if (!bound) {
            // Привязка только по /start с ключом из сборки.
            if (parsed.cmd !== '/start') return;
            const secret = String(getSecret() || '');
            if (!secret || parsed.args[0] !== secret) {
                await send(fromChat, 'Неверный ключ.');
                return;
            }
            bindChatId(fromChat);
            await send(fromChat, 'Подключено к TS Activity Keeper.\n\n' + HELP);
            return;
        }
        if (fromChat !== bound) return; // чужие чаты — молча мимо
        await handleCommand(parsed, fromChat);
    }

    // One getUpdates round-trip. Returns false when the call failed (caller
    // backs off) — exported for tests.
    async function pollOnce() {
        const data = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
        if (!data || !data.ok || !Array.isArray(data.result)) return false;
        for (const update of data.result) {
            if (typeof update.update_id === 'number') offset = Math.max(offset, update.update_id + 1);
            try {
                await processUpdate(update);
            } catch (e) {
                log('telegram update failed: ' + e.message);
            }
        }
        return true;
    }

    async function start() {
        if (running) return;
        running = true;
        while (running && getToken()) {
            let ok = false;
            try {
                ok = await pollOnce();
            } catch (e) {
                log('telegram poll error: ' + e.message);
            }
            if (running && !ok) await wait(5000);
        }
        running = false;
    }

    function stop() { running = false; }

    async function notify(text) {
        if (!getToken() || !getChatId()) return;
        try {
            await send(getChatId(), text);
        } catch (e) {
            log('telegram notify failed: ' + e.message);
        }
    }

    return { start, stop, pollOnce, notify, isRunning: () => running, HELP };
}

module.exports = { createTelegramBot, TELEGRAM_API_BASE, HELP };
