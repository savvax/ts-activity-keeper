// Telegram remote control: long-polls getUpdates and dispatches commands to
// injected handlers. No Electron deps — `request` (axios in production), the
// token/chat-id accessors and the command handlers are all injected, so the
// module is unit-testable with fakes.
//
// Security model: the bot answers exactly one chat. If no chat id is bound
// yet, the first `/start` received binds that chat (persisted via
// `bindChatId`); every message from any other chat is silently ignored.

const TELEGRAM_API_BASE = 'https://api.telegram.org';

const HELP = [
    'TS Activity Keeper — remote control:',
    '/status — tracking status, activity timer, today/week hours',
    '/pause — stop tracking',
    '/resume — start tracking',
    '/logout — sign out of the account (tracking stops)',
    '/quit — quit the app on the Mac',
    '/revoke — delete the bot key from the app and disconnect',
    '/help — this message',
].join('\n');

function createTelegramBot(opts) {
    const request = opts.request;
    const getToken = opts.getToken;
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

    async function handleCommand(cmd, chatId) {
        switch (cmd) {
            case '/start':
            case '/help':
                await send(chatId, HELP);
                break;
            case '/status':
                await send(chatId, await handlers.status());
                break;
            case '/pause':
                await handlers.pause();
                await send(chatId, 'Tracking stopped.');
                break;
            case '/resume':
                await handlers.resume();
                await send(chatId, 'Tracking starting…');
                break;
            case '/logout':
                await send(chatId, 'Logging out — tracking stops; sign in again on the Mac.');
                await handlers.logout();
                break;
            case '/quit':
                await send(chatId, 'Quitting the app on the Mac. Goodbye.');
                await handlers.quit();
                break;
            case '/revoke':
                // Confirm while the token is still valid, then stop polling and
                // let the app delete the key from its config.
                await send(chatId, 'Bot key deleted from the app. This bot is now disconnected.');
                stop();
                await handlers.revoke();
                break;
            default:
                await send(chatId, 'Unknown command. Send /help for the list.');
        }
    }

    async function processUpdate(update) {
        const msg = update && update.message;
        if (!msg || !msg.chat || typeof msg.text !== 'string') return;
        const fromChat = String(msg.chat.id);
        const bound = String(getChatId() || '');
        const cmd = msg.text.trim().split(/[\s@]/)[0].toLowerCase();
        if (!bound) {
            if (cmd === '/start') {
                bindChatId(fromChat);
                await send(fromChat, 'Connected to TS Activity Keeper.\n\n' + HELP);
            }
            return; // unbound: ignore everything except the binding /start
        }
        if (fromChat !== bound) return; // foreign chats are silently ignored
        await handleCommand(cmd, fromChat);
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
