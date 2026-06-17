const { app, BrowserWindow, Tray, nativeImage, ipcMain, Notification, dialog } = require('electron');
const path = require('path');
const zlib = require('zlib');
const { randomInt, formatDuration, formatSeconds } = require('./utils');
const credentials = require('./credentials');
const { renderTrayClock, STATUS_COLORS } = require('./tray-icon');
const { HEALTH, initialHealthState, deriveHealth } = require('./tracking-health');
const { createSessionClock } = require('./session-clock');
const { createNotifier } = require('./notifier');
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
const sessionClock = createSessionClock(() => Date.now());

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
};

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
            height: 460,
            show: false,
            frame: false,
            resizable: false,
            alwaysOnTop: true,
            skipTaskbar: true,
            backgroundColor: '#ffffff',
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
            return;
        }
        updateState('status', 'Active');
        updateState('action', 'Starting tracking...');
        startHeartbeatLoop();
    } catch (e) {
        updateState('status', 'Error');
        updateState('action', e.message);
        running = false;
    }
}

async function stopBot() {
    running = false;
    clearTimeout(heartbeatTimer);
    stopDurationTimer();
    if (notifier) notifier.stop();
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
    const settings = settingsStore.loadSettings();
    if (next.health === HEALTH.COUNTING) {
        sessionClock.resume();
        updateState('status', 'Active');
        if (!trackingState.challengePending) updateState('action', 'Tracking active');
        if (notifier) notifier.restored(settings);
    } else {
        // stalled, disconnected, or connecting-that-resolved-to-not-counting
        sessionClock.pause();
        updateState('status', 'Not counting');
        const msg = next.health === HEALTH.STALLED ? 'Not counting (offline)' : 'No server connection';
        updateState('action', msg);
        if (notifier) notifier.notCounting(msg, settings);
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
        updateState('duration', formatDuration(sessionClock.elapsedMs()));
    }, 1000);
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
        message: `Log out of ${config.email || ''}?`,
        detail: 'Tracking will stop; you will need to sign in again.',
    });
    if (response === 1) await logout();
    return response === 1;
});
ipcMain.on('show-login', () => showSetupWindow());
ipcMain.handle('get-settings', () => settingsStore.loadSettings());
ipcMain.handle('save-settings', (_, patch) => settingsStore.saveSettings(patch));

let setupWindow = null;
let started = false;

ipcMain.handle('save-credentials', async (_, email, password) => {
    if (!email || !password) return false;
    try {
        credentials.save(email, password);
        config.email = email;
        config.password = password;
        state.email = email;
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
        backgroundColor: '#ffffff',
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
    state.email = config.email || '';
    return !!(config.email && config.password);
}

app.whenReady().then(() => {
    notifier = createNotifier({
        createNotification: (opts) => new Notification(opts),
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (id) => clearInterval(id),
    });
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
