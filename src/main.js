const { app, BrowserWindow, Tray, nativeImage, nativeTheme, ipcMain, Notification, dialog } = require('electron');
const path = require('path');
const zlib = require('zlib');
const axios = require('axios');
const { randomInt, formatDuration, formatSeconds, maskLogin } = require('./utils');
const credentials = require('./credentials');
const { renderTrayClock, STATUS_COLORS } = require('./tray-icon');
const { HEALTH, initialHealthState, deriveHealth } = require('./tracking-health');
const { createSessionClock } = require('./session-clock');
const { createNotifier } = require('./notifier');
const { createAutoStop } = require('./auto-stop');
const { createTelegramBot } = require('./telegram-bot');
const settingsStore = require('./settings');
const { createApiTracker } = require('./api-tracker');
const { DEFAULT_DASHBOARD_URL } = require('./endpoints');

require('dotenv').config();

const config = {
    email: '',
    password: '',
    url: process.env.DASHBOARD_URL || DEFAULT_DASHBOARD_URL,
};

let tray = null;
let controlWindow = null;
let running = false;
let durationTimer = null;
let heartbeatTimer = null;
let heartbeatErrors = 0;
let recoveryAttempts = 0;
let isQuitting = false;

let healthState = initialHealthState();
let notifier = null;
let telegramBot = null;
const sessionClock = createSessionClock(() => Date.now());
const autoStop = createAutoStop(() => Date.now());

const MAX_RECOVERY_ATTEMPTS = 5;

let trackingState = {
    challengePending: false,
};

let state = {
    status: 'Stopped',
    duration: '00:00:00',
    action: '-',
    email: config.email || '',
    today: '--:--:--',
    week: '--:--:--',
    challenge: false,
    autoStopRemaining: null, // 'HH:MM:SS' while an auto-stop is armed
    telegramLinked: false,
};

// The raw login never leaves main: everything user-facing goes through here.
function displayEmail() {
    if (!config.email) return '';
    return settingsStore.loadSettings().hideLogin ? maskLogin(config.email) : config.email;
}

function updateState(key, value) {
    state[key] = value;
    sendToControl('state-update', state);
    refreshTrayIcon();
}

function sendToControl(channel, data) {
    if (controlWindow && !controlWindow.isDestroyed()) {
        controlWindow.webContents.send(channel, data);
    }
}

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
}
function pngFromRgba(data, size) {
    const raw = Buffer.alloc((size * 4 + 1) * size);
    for (let y = 0; y < size; y++) {
        raw[y * (size * 4 + 1)] = 0;
        data.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

function trayStatusKey() {
    if (state.challenge) return 'captcha';
    const s = state.status || '';
    if (s === 'Active') return 'running';
    if (s === 'Not counting') return 'notcounting';
    if (s.startsWith('Error')) return 'error';
    if (s === 'Starting...') return 'launching';
    return 'stopped';
}

function createTrayIcon(statusKey) {
    const size = 44;            // 22pt @2x retina menu-bar size
    const ss = 8;               // high supersampling for smooth edges
    const colors = STATUS_COLORS[statusKey] || STATUS_COLORS.stopped;
    const { data } = renderTrayClock(size, ss, colors);
    return nativeImage.createFromBuffer(pngFromRgba(data, size), { scaleFactor: 2.0 });
}

let lastTrayKey = null;
function refreshTrayIcon() {
    if (!tray || tray.isDestroyed()) return;
    const key = trayStatusKey();
    if (key === lastTrayKey) return;
    lastTrayKey = key;
    tray.setImage(createTrayIcon(key));
}

function createTray() {
    lastTrayKey = trayStatusKey();
    tray = new Tray(createTrayIcon(lastTrayKey));
    tray.setToolTip('TS Activity Keeper');
    tray.on('click', toggleControlWindow);
}

function toggleControlWindow() {
    if (controlWindow && !controlWindow.isDestroyed()) {
        if (controlWindow.isVisible()) {
            controlWindow.hide();
        } else {
            showControlWindow();
        }
    } else {
        showControlWindow();
    }
}

function showControlWindow() {
    if (!controlWindow || controlWindow.isDestroyed()) {
        controlWindow = new BrowserWindow({
            width: 320,
            height: 500,
            show: false,
            frame: false,
            resizable: false,
            alwaysOnTop: true,
            skipTaskbar: true,
            backgroundColor: nativeTheme.shouldUseDarkColors ? '#131316' : '#f5f4f0',
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false
            }
        });

        controlWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

        controlWindow.on('blur', () => {
            setTimeout(() => {
                if (controlWindow && !controlWindow.isDestroyed() && controlWindow.isVisible()) {
                    controlWindow.hide();
                }
            }, 150);
        });
    }

    const bounds = tray.getBounds();
    controlWindow.setPosition(
        Math.round(bounds.x + bounds.width / 2 - 160),
        bounds.y + bounds.height + 4
    );

    controlWindow.show();
    sendToControl('state-update', state);
}

const apiBackend = createApiTracker({
    dashboardUrl: config.url,
    getCredentials: () => ({ email: config.email, password: config.password }),
});

const backend = apiBackend;

async function startBot() {
    if (running) return;

    running = true;
    healthState = initialHealthState();
    sessionClock.reset();
    if (notifier) notifier.stop();
    armAutoStop();
    startDurationTimer();
    updateState('status', 'Starting...');

    try {
        apiBackend.reset();
        updateState('action', 'Authorizing (API)...');
        const ok = await apiBackend.ensureAuth();
        if (!ok) {
            updateState('status', 'Error');
            updateState('action', 'Authorization failed');
            running = false;
            stopDurationTimer();
            autoStop.disarm();
            updateState('autoStopRemaining', null);
            return;
        }
        updateState('status', 'Active');
        updateState('action', 'Starting tracking...');
        startHeartbeatLoop();
    } catch (e) {
        updateState('status', 'Error');
        updateState('action', e.message);
        running = false;
        stopDurationTimer();
        autoStop.disarm();
        updateState('autoStopRemaining', null);
    }
}

async function stopBot() {
    running = false;
    clearTimeout(heartbeatTimer);
    stopDurationTimer();
    if (notifier) notifier.stop();
    autoStop.disarm();
    updateState('autoStopRemaining', null);
    sessionClock.reset();
    healthState = initialHealthState();

    updateState('status', 'Stopped');
    updateState('action', 'Stopping tracking...');

    await backend.stop();

    trackingState.challengePending = false;
    updateState('action', '-');
    updateState('duration', '00:00:00');
    updateState('challenge', false);
}

function updateProgress(todaySeconds, weekSeconds) {
    if (typeof todaySeconds === 'number') updateState('today', formatSeconds(todaySeconds));
    if (typeof weekSeconds === 'number') updateState('week', formatSeconds(weekSeconds));
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
        updateState('status', 'Active');
        if (!trackingState.challengePending) updateState('action', 'Tracking active');
        if (notifier) notifier.restored();
        telegramNotify('✅ Time is being counted.');
    } else {
        // stalled, disconnected, or connecting-that-resolved-to-not-counting
        sessionClock.pause();
        updateState('status', 'Not counting');
        const msg = next.health === HEALTH.STALLED ? 'Not counting (offline)' : 'No server connection';
        updateState('action', msg);
        if (notifier) notifier.notCounting(msg);
        telegramNotify('⚠️ Time is NOT being counted: ' + msg);
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

    // Today/week hours come from the dashboard endpoint and are available even
    // when tracking can't run (e.g. off the campus network). Fetch them
    // independently so they show regardless of heartbeat success.
    if (typeof backend.fetchProgress === 'function') {
        try {
            const progress = await backend.fetchProgress();
            if (progress) updateProgress(progress.todaySeconds, progress.weekSeconds);
        } catch (e) {
            // best-effort; don't disrupt the heartbeat loop
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
            trackingState.challengePending = !!hb.challengePending;
            updateState('challenge', trackingState.challengePending);
            if (trackingState.challengePending) {
                updateState('action', 'Captcha — verification needed');
            }
        }
        processHealth({ hbOk: true, today });
    } catch (e) {
        heartbeatErrors++;
        console.error(`[TRACKING] Heartbeat error (${heartbeatErrors}/3):`, e.message);
        processHealth({ hbOk: false, today: null });
        if (heartbeatErrors >= 3) {
            heartbeatErrors = 0;
            if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
                console.error(`[TRACKING] Recovery attempts exhausted (${recoveryAttempts}); pausing recovery to avoid account lockout`);
                updateState('action', 'Tracking error — verification needed');
            } else {
                recoveryAttempts++;
                console.log(`[TRACKING] Recovering (attempt ${recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS})...`);
                updateState('action', 'Recovering tracking...');
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

function startDurationTimer() {
    stopDurationTimer();
    durationTimer = setInterval(() => {
        state.autoStopRemaining = autoStop.isArmed() ? formatDuration(autoStop.remainingMs()) : null;
        updateState('duration', formatDuration(sessionClock.elapsedMs()));
        if (autoStop.expired()) onAutoStopExpired();
    }, 1000);
}

// ---- Auto-stop timer -------------------------------------------------------

function armAutoStop() {
    const settings = settingsStore.loadSettings();
    autoStop.arm(settings.autoStopMinutes * 60 * 1000);
    state.autoStopRemaining = autoStop.isArmed() ? formatDuration(autoStop.remainingMs()) : null;
}

async function onAutoStopExpired() {
    autoStop.disarm();
    const settings = settingsStore.loadSettings();
    const andLogout = settings.autoStopLogout;
    const msg = andLogout
        ? 'Auto-stop timer fired — tracking stopped and you were logged out.'
        : 'Auto-stop timer fired — tracking stopped.';
    if (notifier) notifier.info(msg);
    telegramNotify('⏱ ' + msg);
    if (andLogout) await logout();
    else await stopBot();
}

// ---- Telegram remote control -----------------------------------------------

function telegramNotify(text) {
    if (telegramBot) telegramBot.notify(text);
}

function telegramStatusText() {
    const s = settingsStore.loadSettings();
    const lines = [
        `Status: ${state.status}`,
        `Action: ${state.action}`,
        `Activity (session): ${state.duration}`,
        `Today: ${state.today}`,
        `Week: ${state.week}`,
        `Login: ${displayEmail() || '-'}`,
    ];
    if (state.autoStopRemaining) {
        lines.push(`Auto-stop in: ${state.autoStopRemaining}${s.autoStopLogout ? ' (then logout)' : ''}`);
    }
    if (state.challenge) lines.push('⚠️ Captcha verification pending');
    return lines.join('\n');
}

function syncTelegram() {
    const settings = settingsStore.loadSettings();
    updateState('telegramLinked', !!(settings.telegramToken && settings.telegramChatId));
    if (!telegramBot) return;
    if (settings.telegramToken) {
        if (!telegramBot.isRunning()) telegramBot.start(); // floating long-poll loop
    } else {
        telegramBot.stop();
    }
}

function createTelegram() {
    telegramBot = createTelegramBot({
        request: (cfg) => axios(cfg),
        getToken: () => settingsStore.loadSettings().telegramToken,
        getChatId: () => settingsStore.loadSettings().telegramChatId,
        bindChatId: (chatId) => {
            settingsStore.saveSettings({ telegramChatId: chatId });
            updateState('telegramLinked', true);
        },
        handlers: {
            status: async () => telegramStatusText(),
            pause: () => stopBot(),
            resume: async () => { startBot(); },
            logout: () => logout(),
            quit: async () => { app.isQuitting = true; app.quit(); },
            revoke: async () => {
                settingsStore.saveSettings({ telegramToken: '', telegramChatId: '' });
                updateState('telegramLinked', false);
            },
        },
        log: (msg) => console.error('[TELEGRAM]', msg),
    });
    syncTelegram();
}

function stopDurationTimer() {
    if (durationTimer) {
        clearInterval(durationTimer);
        durationTimer = null;
    }
}

ipcMain.handle('get-state', () => state);
ipcMain.on('start-bot', () => startBot());
ipcMain.on('stop-bot', () => stopBot());
ipcMain.on('quit', () => { app.isQuitting = true; app.quit(); });
ipcMain.handle('logout', async () => {
    const { response } = await dialog.showMessageBox(controlWindow, {
        type: 'question',
        buttons: ['Cancel', 'Log out'],
        defaultId: 1,
        cancelId: 0,
        message: `Log out of ${displayEmail() || 'the current account'}?`,
        detail: 'Tracking will stop; you will need to sign in again.',
    });
    if (response === 1) await logout();
    return response === 1;
});
ipcMain.on('show-login', () => showSetupWindow());
ipcMain.handle('get-settings', () => settingsStore.loadSettings());
ipcMain.handle('save-settings', (_, patch) => {
    const saved = settingsStore.saveSettings(patch);
    if (running) armAutoStop(); // new duration applies immediately
    updateState('email', displayEmail());
    syncTelegram();
    return saved;
});

let setupWindow = null;
let started = false;

ipcMain.handle('save-credentials', async (_, email, password) => {
    if (!email || !password) return false;
    try {
        credentials.save(email, password);
        config.email = email;
        config.password = password;
        state.email = displayEmail();
        if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
        if (!started) {
            started = true;
            startApp();          // first launch: create tray + start tracking
        } else {
            startBot();          // re-login after logout: tray exists, running already false
        }
        return true;
    } catch (e) {
        console.error('[CREDENTIALS] save failed:', e.message);
        return false;
    }
});

function showSetupWindow() {
    if (setupWindow && !setupWindow.isDestroyed()) {
        setupWindow.show();
        setupWindow.focus();
        return;
    }
    setupWindow = new BrowserWindow({
        width: 360,
        height: 460,
        show: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#131316' : '#f5f4f0',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    setupWindow.loadFile(path.join(__dirname, 'renderer', 'setup.html'));
    setupWindow.on('closed', () => {
        setupWindow = null;
        if (!started) app.quit();
    });
}

function startApp() {
    createTray();
    setTimeout(startBot, 2000);
}

async function logout() {
    // 1. Stop tracking first — POSTs the API stop with the live session.
    await stopBot();
    // 2. Forget credentials (settings are preserved by config-store merge).
    credentials.clear();
    // 3. Forget the previous account's tracking session (in-memory cookies) so
    //    the next login starts clean.
    trackingState = { challengePending: false };
    apiBackend.reset();
    recoveryAttempts = 0;
    heartbeatErrors = 0;
    // 5. Reset in-memory account + displayed state.
    config.email = '';
    config.password = '';
    state.email = '';
    updateState('status', 'Stopped');
    updateState('action', '-');
    updateState('today', '--:--:--');
    updateState('week', '--:--:--');
    updateState('duration', '00:00:00');
    updateState('challenge', false);
    // 6. Tray stays; `started` stays true (app keeps running). Show the login screen.
    showSetupWindow();
}

function resolveCredentials() {
    const saved = credentials.loadSaved();
    config.email = saved.email;
    config.password = saved.password;
    state.email = displayEmail();
    return !!(config.email && config.password);
}

app.whenReady().then(() => {
    notifier = createNotifier({
        createNotification: (opts) => new Notification(opts),
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (id) => clearInterval(id),
        getSettings: () => settingsStore.loadSettings(),
    });
    createTelegram();
    if (app.dock) app.dock.hide();
    if (resolveCredentials()) {
        started = true;
        startApp();
    } else {
        showSetupWindow();
    }
});

app.on('window-all-closed', (e) => {
    e.preventDefault();
});

app.on('before-quit', (e) => {
    if (telegramBot) telegramBot.stop();
    if (isQuitting) return;
    if (running) {
        isQuitting = true;
        app.isQuitting = true;
        e.preventDefault();
        running = false;
        if (notifier) notifier.stop();
        clearTimeout(heartbeatTimer);
        stopDurationTimer();
        Promise.race([
            backend.stop(4000),
            new Promise((resolve) => setTimeout(resolve, 5000)),
        ]).finally(() => app.quit());
    }
});
