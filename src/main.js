// Electron main process: headless-демон без единого окна и иконки.
// Всё общение с человеком идёт через Telegram (`telegram-bot.js`); здесь
// остаётся только оркестрация: трекинг-цикл, health, автостоп, keep-awake,
// автозапуск и wiring хендлеров бота.

const { app, powerSaveBlocker } = require('electron');
const axios = require('axios');
const { randomInt, formatDuration, formatSeconds, maskLogin } = require('./utils');
const credentials = require('./credentials');
const { HEALTH, initialHealthState, deriveHealth } = require('./tracking-health');
const { createSessionClock } = require('./session-clock');
const { createReminder } = require('./reminder');
const { createAutoStop } = require('./auto-stop');
const { createTelegramBot } = require('./telegram-bot');
const { createKeepAwake } = require('./keep-awake');
const { ensureAutostart, describeAutostart } = require('./launch-agent');
const { loadBuildSecrets } = require('./build-config-loader');
const settingsStore = require('./settings');
const { createApiTracker } = require('./api-tracker');
const { DEFAULT_DASHBOARD_URL } = require('./endpoints');

require('dotenv').config();

const VERSION = require('../package.json').version;
const secrets = loadBuildSecrets();
const startedAt = Date.now();

const config = {
    email: '',
    password: '',
    url: process.env.DASHBOARD_URL || DEFAULT_DASHBOARD_URL,
};

let running = false;
let durationTimer = null;
let heartbeatTimer = null;
let heartbeatErrors = 0;
let recoveryAttempts = 0;
let isQuitting = false;
let autostartResult = null;

let healthState = initialHealthState();
let reminder = null;
let telegramBot = null;
let keepAwake = null;
const sessionClock = createSessionClock(() => Date.now());
const autoStop = createAutoStop(() => Date.now());

const MAX_RECOVERY_ATTEMPTS = 5;

let trackingState = {
    challengePending: false,
};

let state = {
    status: 'Остановлен',
    action: '-',
    duration: '00:00:00',
    today: '--:--:--',
    week: '--:--:--',
    challenge: false,
    autoStopRemaining: null, // 'HH:MM:SS' пока автостоп взведён
};

// Сырой логин никогда не покидает main: всё пользовательское идёт через это.
function displayEmail() {
    if (!config.email) return '';
    return settingsStore.loadSettings().hideLogin ? maskLogin(config.email) : config.email;
}

const apiBackend = createApiTracker({
    dashboardUrl: config.url,
    getCredentials: () => ({ email: config.email, password: config.password }),
});

const backend = apiBackend;

// ---- Трекинг ---------------------------------------------------------------

async function startBot() {
    if (running) return 'Трекинг уже идёт.';
    if (!config.email || !config.password) return 'Нет аккаунта. Войди: /login <email> <пароль>';

    running = true;
    healthState = initialHealthState();
    sessionClock.reset();
    if (reminder) reminder.stop();
    armAutoStop();
    startDurationTimer();
    state.status = 'Запускается';
    state.action = 'Авторизация...';

    try {
        apiBackend.reset();
        const ok = await apiBackend.ensureAuth();
        if (!ok) {
            failStart('Авторизация не удалась — проверь логин и пароль');
            return 'Авторизация не удалась.';
        }
        state.status = 'Активен';
        state.action = 'Запуск трекинга...';
        startHeartbeatLoop();
        return 'Трекинг запускается.';
    } catch (e) {
        failStart(e.message);
        return 'Ошибка запуска: ' + e.message;
    }
}

function failStart(message) {
    state.status = 'Ошибка';
    state.action = message;
    running = false;
    stopDurationTimer();
    autoStop.disarm();
    state.autoStopRemaining = null;
    telegramNotify('❌ Ошибка авторизации: ' + message);
}

async function stopBot() {
    running = false;
    clearTimeout(heartbeatTimer);
    stopDurationTimer();
    if (reminder) reminder.stop();
    autoStop.disarm();
    state.autoStopRemaining = null;
    sessionClock.reset();
    healthState = initialHealthState();

    state.status = 'Остановлен';
    state.action = 'Остановка трекинга...';

    await backend.stop();

    trackingState.challengePending = false;
    state.action = '-';
    state.duration = '00:00:00';
    state.challenge = false;
}

function updateProgress(todaySeconds, weekSeconds) {
    if (typeof todaySeconds === 'number') state.today = formatSeconds(todaySeconds);
    if (typeof weekSeconds === 'number') state.week = formatSeconds(weekSeconds);
}

function heartbeatInterval() {
    return randomInt(15000, 25000);
}

function processHealth(event) {
    const prev = healthState;
    const next = deriveHealth(prev, event);
    healthState = next;
    if (next.health !== prev.health) applyHealth(next);
}

function applyHealth(next) {
    if (next.health === HEALTH.COUNTING) {
        sessionClock.resume();
        state.status = 'Активен';
        if (!trackingState.challengePending) state.action = 'Время считается';
        if (reminder) reminder.restored();
    } else {
        // stalled, disconnected или connecting, разрешившийся в «не считается»
        sessionClock.pause();
        state.status = 'Не считается';
        const msg = next.health === HEALTH.STALLED ? 'сервер отвечает, но время не растёт' : 'нет связи с сервером';
        state.action = msg;
        if (reminder) reminder.notCounting(msg);
    }
}

function startHeartbeatLoop() {
    clearTimeout(heartbeatTimer);
    heartbeatErrors = 0;
    heartbeatLoop();
}

async function heartbeatLoop() {
    if (!running) return;

    if (!backend.isAvailable()) {
        processHealth({ hbOk: false, today: null });
        if (running) heartbeatTimer = setTimeout(heartbeatLoop, heartbeatInterval());
        return;
    }

    // Часы за день/неделю приходят с дашборда и доступны, даже когда трекинг
    // не идёт — тянем их отдельно от heartbeat.
    if (typeof backend.fetchProgress === 'function') {
        try {
            const progress = await backend.fetchProgress();
            if (progress) updateProgress(progress.todaySeconds, progress.weekSeconds);
        } catch (e) {
            // best-effort, цикл не ломаем
        }
    }

    if (!backend.isStarted()) {
        try {
            await backend.ensureStarted();
        } catch (e) {
            console.error('[TRACKING] Re-start failed:', e.message);
        }
    }

    try {
        const hb = await backend.heartbeat();
        heartbeatErrors = 0;
        recoveryAttempts = 0;
        let today = null;
        if (hb) {
            updateProgress(hb.todaySeconds, hb.weekSeconds);
            if (typeof hb.todaySeconds === 'number') today = hb.todaySeconds;
            console.log(`[TRACKING] heartbeat ok: today=${hb.todaySeconds}s week=${hb.weekSeconds}s challenge=${hb.challengePending}`);
            setChallenge(!!hb.challengePending);
        }
        processHealth({ hbOk: true, today });
    } catch (e) {
        heartbeatErrors++;
        console.error(`[TRACKING] Heartbeat error (${heartbeatErrors}/3):`, e.message);
        processHealth({ hbOk: false, today: null });
        if (heartbeatErrors >= 3) {
            heartbeatErrors = 0;
            if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
                console.error(`[TRACKING] Recovery attempts exhausted (${recoveryAttempts})`);
                state.action = 'Ошибка трекинга — нужна проверка';
                telegramNotify('🛑 Восстановить трекинг не удалось — нужна проверка вручную на Маке.');
            } else {
                recoveryAttempts++;
                console.log(`[TRACKING] Recovering (attempt ${recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS})...`);
                state.action = 'Восстановление трекинга...';
                try {
                    await backend.recover();
                } catch (recoveryErr) {
                    console.error('[TRACKING] Recovery failed:', recoveryErr.message);
                }
            }
        }
    }

    if (running) {
        heartbeatTimer = setTimeout(heartbeatLoop, heartbeatInterval());
    }
}

// Капча: сообщаем один раз на переход false -> true.
function setChallenge(pending) {
    const was = trackingState.challengePending;
    trackingState.challengePending = pending;
    state.challenge = pending;
    if (pending) {
        state.action = 'Капча — нужна проверка';
        if (!was) telegramNotify('🤖 Требуется проверка (капча) — зайди на дашборд с Мака.');
    }
}

function startDurationTimer() {
    stopDurationTimer();
    durationTimer = setInterval(() => {
        state.autoStopRemaining = autoStop.isArmed() ? formatDuration(autoStop.remainingMs()) : null;
        state.duration = formatDuration(sessionClock.elapsedMs());
        if (autoStop.expired()) onAutoStopExpired();
    }, 1000);
}

function stopDurationTimer() {
    if (durationTimer) {
        clearInterval(durationTimer);
        durationTimer = null;
    }
}

// ---- Автостоп --------------------------------------------------------------

function armAutoStop() {
    const settings = settingsStore.loadSettings();
    autoStop.arm(settings.autoStopMinutes * 60 * 1000);
    state.autoStopRemaining = autoStop.isArmed() ? formatDuration(autoStop.remainingMs()) : null;
}

async function onAutoStopExpired() {
    autoStop.disarm();
    const settings = settingsStore.loadSettings();
    const andLogout = settings.autoStopLogout;
    telegramNotify(andLogout
        ? '⏱ Сработал автостоп — трекинг остановлен, аккаунт разлогинен.'
        : '⏱ Сработал автостоп — трекинг остановлен.');
    if (andLogout) await logout();
    else await stopBot();
}

// ---- Аккаунт ---------------------------------------------------------------

async function logout() {
    await stopBot();
    credentials.clear();
    trackingState = { challengePending: false };
    apiBackend.reset();
    recoveryAttempts = 0;
    heartbeatErrors = 0;
    config.email = '';
    config.password = '';
    state.status = 'Остановлен';
    state.action = '-';
    state.today = '--:--:--';
    state.week = '--:--:--';
    state.duration = '00:00:00';
    state.challenge = false;
}

function resolveCredentials() {
    const saved = credentials.loadSaved();
    config.email = saved.email;
    config.password = saved.password;
    return !!(config.email && config.password);
}

// ---- Telegram --------------------------------------------------------------

function telegramNotify(text) {
    if (telegramBot) telegramBot.notify(text);
}

function statusText() {
    const s = settingsStore.loadSettings();
    const lines = [
        `Статус: ${state.status}`,
        `Действие: ${state.action}`,
        `Сессия: ${state.duration}`,
        `Сегодня: ${state.today}`,
        `Неделя: ${state.week}`,
        `Логин: ${displayEmail() || '-'}`,
        `Автостоп: ${state.autoStopRemaining
            ? `через ${state.autoStopRemaining}${s.autoStopLogout ? ' (затем логаут)' : ''}`
            : 'выключен'}`,
        `Автозапуск: ${describeAutostart(autostartResult)}`,
        `Напоминания: ${s.remindMinutes ? `каждые ${s.remindMinutes} мин` : 'выкл'}`,
        `Keep-awake: ${keepAwake && keepAwake.isActive() ? 'активен' : 'неактивен'}`,
        `Аптайм: ${formatDuration(Date.now() - startedAt)} · версия ${VERSION}`,
    ];
    if (state.challenge) lines.push('⚠️ Требуется проверка (капча)');
    return lines.join('\n');
}

function startupText() {
    const trackingLine = config.email && config.password
        ? 'Трекинг: стартует'
        : 'Трекинг: ждёт /login <email> <пароль>';
    return [
        `▶️ TS Activity Keeper запущен (v${VERSION})`,
        trackingLine,
        `Автозапуск: ${describeAutostart(autostartResult)}`,
        `Keep-awake: ${keepAwake && keepAwake.isActive() ? 'активен' : 'неактивен'}`,
    ].join('\n');
}

function createTelegram() {
    telegramBot = createTelegramBot({
        request: (cfg) => axios(cfg),
        getToken: () => secrets.token,
        getSecret: () => secrets.secret,
        getChatId: () => settingsStore.loadSettings().telegramChatId,
        bindChatId: (chatId) => settingsStore.saveSettings({ telegramChatId: chatId }),
        handlers: {
            status: async () => statusText(),
            login: async (email, password) => {
                try {
                    credentials.save(email, password);
                } catch (e) {
                    return 'Не удалось сохранить аккаунт: ' + e.message;
                }
                config.email = email;
                config.password = password;
                if (running) await stopBot();
                return await startBot();
            },
            logout: async () => {
                await logout();
                return 'Вышел из аккаунта. Войти снова: /login <email> <пароль>';
            },
            pause: async () => {
                await stopBot();
                return 'Трекинг остановлен.';
            },
            resume: async () => startBot(),
            autostop: async (minutes, andLogout) => {
                settingsStore.saveSettings({ autoStopMinutes: minutes, autoStopLogout: andLogout });
                if (running) armAutoStop();
                return minutes
                    ? `Автостоп: через ${minutes} мин${andLogout ? ' с логаутом' : ''}.`
                    : 'Автостоп выключен.';
            },
            autostart: async (on) => {
                settingsStore.saveSettings({ autostart: on });
                autostartResult = ensureAutostart({ app, desired: on });
                return 'Автозапуск: ' + describeAutostart(autostartResult);
            },
            remind: async (minutes) => {
                settingsStore.saveSettings({ remindMinutes: minutes });
                return minutes
                    ? `Напоминания: каждые ${minutes} мин.`
                    : 'Напоминания выключены (сообщения о смене состояния остаются).';
            },
            hidelogin: async () => {
                settingsStore.saveSettings({ hideLogin: true });
                return 'Логин теперь маскируется: ' + displayEmail();
            },
            quit: async () => {
                isQuitting = true;
                app.isQuitting = true;
                app.quit();
            },
        },
        log: (msg) => console.error('[TELEGRAM]', msg),
    });
    if (secrets.token) telegramBot.start(); // висячий long-poll цикл
    else console.error('[TELEGRAM] токен не вшит в сборку — remote control отключён');
}

// ---- Запуск ----------------------------------------------------------------

app.whenReady().then(async () => {
    if (app.dock) app.dock.hide();

    keepAwake = createKeepAwake({
        blocker: powerSaveBlocker,
        log: (msg) => console.error('[KEEP-AWAKE]', msg),
    });
    keepAwake.start();

    const settings = settingsStore.loadSettings();
    autostartResult = ensureAutostart({ app, desired: settings.autostart });
    if (!autostartResult.ok) {
        console.error('[AUTOSTART]', describeAutostart(autostartResult));
    }

    reminder = createReminder({
        send: (text) => telegramNotify(text),
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (id) => clearInterval(id),
        getIntervalMinutes: () => settingsStore.loadSettings().remindMinutes,
    });

    createTelegram();

    const hasAccount = resolveCredentials();
    telegramNotify(startupText());
    if (hasAccount) setTimeout(startBot, 2000);
});

app.on('window-all-closed', (e) => {
    e.preventDefault();
});

app.on('before-quit', (e) => {
    if (telegramBot) telegramBot.stop();
    if (keepAwake) keepAwake.stop();
    if (isQuitting) return;
    if (running) {
        isQuitting = true;
        app.isQuitting = true;
        e.preventDefault();
        running = false;
        if (reminder) reminder.stop();
        clearTimeout(heartbeatTimer);
        stopDurationTimer();
        Promise.race([
            backend.stop(4000),
            new Promise((resolve) => setTimeout(resolve, 5000)),
        ]).finally(() => app.quit());
    }
});
