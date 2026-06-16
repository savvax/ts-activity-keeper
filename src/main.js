const { app, BrowserWindow, Tray, nativeImage, ipcMain, session, Notification, dialog } = require('electron');
const path = require('path');
const zlib = require('zlib');
const { randomInt, formatDuration, formatSeconds, generateFingerprint } = require('./utils');
const credentials = require('./credentials');
const { renderTrayClock, STATUS_COLORS } = require('./tray-icon');
const { HEALTH, initialHealthState, deriveHealth } = require('./tracking-health');
const { createSessionClock } = require('./session-clock');
const { createNotifier } = require('./notifier');
const settingsStore = require('./settings');
const { createApiTracker } = require('./api-tracker');
const { readConfig } = require('./config-store');
const { DEFAULT_DASHBOARD_URL } = require('./endpoints');

require('dotenv').config();

const config = {
    email: '',
    password: '',
    url: process.env.DASHBOARD_URL || DEFAULT_DASHBOARD_URL,
    mode: 'api',
};

let tray = null;
let controlWindow = null;
let dashboardWindow = null;
let running = false;
let activityTimer = null;
let refreshTimer = null;
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
    deviceId: '',
    fingerprint: '',
    active: false,
    challengePending: false,
    csrfToken: '',
};

let state = {
    status: 'Stopped',
    duration: '00:00:00',
    action: '-',
    email: config.email || '',
    mode: config.mode,
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

function createDashboardWindow() {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) return dashboardWindow;

    const ses = session.fromPartition('persist:dashboard');

    ses.webRequest.onCompleted((details) => {
        if (details.url.includes('/api/')) {
            const apiPath = details.url.substring(details.url.indexOf('/api/'));
            console.log(`[REQUEST] ${details.method} ${apiPath} -> ${details.statusCode}`);
        }
    });

    dashboardWindow = new BrowserWindow({
        width: 1920,
        height: 1080,
        show: false,
        webPreferences: {
            partition: 'persist:dashboard',
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    dashboardWindow.webContents.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    dashboardWindow.on('close', (e) => {
        if (!app.isQuitting) {
            e.preventDefault();
            dashboardWindow.hide();
        }
    });

    return dashboardWindow;
}

function showDashboard() {
    if (config.mode === 'api') return; // no dashboard window exists in api mode
    createDashboardWindow();
    dashboardWindow.show();
    dashboardWindow.focus();
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

const browserBackend = {
    isAvailable: () => !!dashboardWindow && !dashboardWindow.isDestroyed() && isOnDashboard(),
    isStarted: () => trackingState.active,
    ensureStarted: () => ensureTrackingStarted(),
    heartbeat: () => sendHeartbeat(),
    stop: (timeout) => stopTracking(timeout),
    recover: async () => {
        if (!(await checkAuth())) await login();
        await ensureTrackingStarted();
    },
    reset: () => {},
};

let backend = browserBackend;

const apiBackend = createApiTracker({
    dashboardUrl: config.url,
    getCredentials: () => ({ email: config.email, password: config.password }),
});

async function startBot() {
    if (running) return;

    running = true;
    healthState = initialHealthState();
    sessionClock.reset();
    if (notifier) notifier.stop();
    startDurationTimer();
    updateState('status', 'Starting...');

    backend = config.mode === 'api' ? apiBackend : browserBackend;

    try {
        if (config.mode === 'api') {
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
            return;
        }

        // Browser modes: window / background
        createDashboardWindow();
        updateState('action', 'Loading dashboard...');
        dashboardWindow.loadURL(config.url);
        await waitForLoad(dashboardWindow, 30000);
        await delay(1500);

        const isAuth = await checkAuth();

        if (!isAuth) {
            updateState('action', 'Authorizing...');
            const loggedIn = await login();
            if (!loggedIn) {
                updateState('status', 'Error');
                updateState('action', 'Authorization failed');
                running = false;
                stopDurationTimer();
                return;
            }
        } else {
            updateState('action', 'Already authorized');
        }

        if (config.mode === 'background' && dashboardWindow) {
            dashboardWindow.hide();
        }

        updateState('status', 'Active');
        updateState('action', 'Starting tracking...');

        startHeartbeatLoop();

        startActivityLoop();
        scheduleRefresh();

    } catch (e) {
        updateState('status', 'Error');
        updateState('action', e.message);
        running = false;
    }
}

async function stopBot() {
    running = false;
    clearTimeout(activityTimer);
    clearTimeout(refreshTimer);
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

async function safeExecuteJS(code, timeout = 10000) {
    try {
        if (!dashboardWindow || dashboardWindow.isDestroyed()) return null;
        return await Promise.race([
            dashboardWindow.webContents.executeJavaScript(code),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('JS timeout')), timeout)
            )
        ]);
    } catch {
        return null;
    }
}

function firstDefined() {
    for (let i = 0; i < arguments.length; i++) {
        if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i];
    }
    return undefined;
}

function isOnDashboard() {
    if (!dashboardWindow || dashboardWindow.isDestroyed()) return false;
    try {
        const host = new URL(config.url).hostname;
        return dashboardWindow.webContents.getURL().includes(host);
    } catch {
        return false;
    }
}

function updateProgress(todaySeconds, weekSeconds) {
    if (typeof todaySeconds === 'number') updateState('today', formatSeconds(todaySeconds));
    if (typeof weekSeconds === 'number') updateState('week', formatSeconds(weekSeconds));
}

async function getTrackingStatus() {
    if (!isOnDashboard()) return null;
    const result = await safeExecuteJS(`
        fetch('/api/v1/dashboard', { credentials: 'include' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                if (!d) return null;
                var t = d.tracking || {};
                var h = d.hours || {};
                return {
                    active: !!t.active,
                    deviceId: t.deviceId || '',
                    todaySeconds: h.todaySeconds != null ? h.todaySeconds : null,
                    weekSeconds: h.weekSeconds != null ? h.weekSeconds : null
                };
            })
            .catch(function () { return null; })
    `, 10000);
    return result || null;
}

async function trackingFetch(apiPath, body, timeout = 12000) {
    if (!isOnDashboard()) return { ok: false, status: 0, error: 'not on dashboard' };
    const cachedCsrf = trackingState.csrfToken || '';
    const result = await safeExecuteJS(`
        (async function () {
            async function getCsrf() {
                try {
                    var me = await fetch('/api/v1/auth/me', { credentials: 'include' });
                    if (me.ok) return ((await me.json()) || {}).csrfToken || '';
                } catch (e) {}
                return '';
            }
            try {
                var csrf = ${JSON.stringify(cachedCsrf)} || await getCsrf();
                function headersWith(c) {
                    var h = { 'Content-Type': 'application/json' };
                    if (c) h['x-csrf-token'] = c;
                    return h;
                }
                async function doPost(c) {
                    return fetch(${JSON.stringify(apiPath)}, {
                        method: 'POST',
                        credentials: 'include',
                        headers: headersWith(c),
                        body: JSON.stringify(${JSON.stringify(body)})
                    });
                }
                var r = await doPost(csrf);
                if (r.status === 403) {
                    csrf = await getCsrf();
                    r = await doPost(csrf);
                }
                var data = {};
                try { data = await r.json(); } catch (e) {}
                return { ok: r.ok, status: r.status, data: data, csrf: csrf };
            } catch (e) {
                return { ok: false, status: 0, error: String(e) };
            }
        })()
    `, timeout);
    if (result && result.csrf) trackingState.csrfToken = result.csrf;
    return result || { ok: false, status: 0, error: 'no result' };
}

async function ensureTrackingStarted() {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        const status = await getTrackingStatus();
        if (status) {
            updateProgress(status.todaySeconds, status.weekSeconds);
            console.log(`[TRACKING] dashboard progress: today=${status.todaySeconds}s week=${status.weekSeconds}s active=${status.active}`);
        }

        const deviceId = `keeper-${Date.now()}`;
        const fingerprint = generateFingerprint(deviceId);
        const res = await trackingFetch('/api/v1/tracking/start', {
            deviceId,
            deviceName: 'Activity Keeper',
            fingerprint,
        });

        if (res && res.ok) {
            const returnedDeviceId = (res.data && res.data.tracking && res.data.tracking.deviceId) || deviceId;
            trackingState.deviceId = returnedDeviceId;
            trackingState.fingerprint = fingerprint;
            trackingState.active = true;
            recoveryAttempts = 0;
            console.log('[TRACKING] Started session:', trackingState.deviceId);
            return;
        }

        lastErr = new Error(`start failed (${res && res.status}): ${(res && res.data && res.data.error) || 'unknown'}`);
        console.warn(`[TRACKING] start attempt ${attempt}/3: ${lastErr.message}`);
        if (attempt < 3) await delay(2000);
    }
    throw lastErr;
}

async function sendHeartbeat() {
    if (!trackingState.deviceId) return null;
    const res = await trackingFetch('/api/v1/tracking/heartbeat', {
        deviceId: trackingState.deviceId,
        fingerprint: trackingState.fingerprint,
    });
    if (!res || !res.ok) {
        throw new Error(`heartbeat failed (${res && res.status})`);
    }
    const data = (res && res.data) || {};
    const tracking = data.tracking || {};
    return {
        todaySeconds: firstDefined(data.todaySeconds, tracking.todaySeconds),
        weekSeconds: firstDefined(data.weekSeconds, tracking.weekSeconds),
        challengePending: !!tracking.challengePending,
    };
}

async function stopTracking(timeout = 12000) {
    if (!trackingState.active || !trackingState.deviceId) return;
    const deviceId = trackingState.deviceId;
    const fingerprint = trackingState.fingerprint;
    try {
        const res = await trackingFetch('/api/v1/tracking/stop', { deviceId, fingerprint }, timeout);
        if (res && res.ok) {
            trackingState.active = false;
            console.log(`[TRACKING] Stop (${res.status}):`, deviceId);
        } else {
            console.error(`[TRACKING] Stop failed (${res && res.status}); session left active for retry`);
        }
    } catch (e) {
        console.error('[TRACKING] Stop failed:', e.message);
    }
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
        if (!trackingState.challengePending) updateState('action', 'Emulating activity');
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

async function checkAuth() {
    try {
        if (!dashboardWindow || dashboardWindow.isDestroyed()) return false;
        const url = dashboardWindow.webContents.getURL();
        const dashboardHost = new URL(config.url).hostname;
        if (!url.includes(dashboardHost)) return false;
        const result = await safeExecuteJS(`
            fetch('/api/v1/auth/me', { credentials: 'include' })
                .then(r => r.json())
                .then(d => d.authenticated === true)
                .catch(() => false)
        `, 8000);
        return result === true;
    } catch {
        return false;
    }
}

async function waitForSelector(selector, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout && running) {
        if (!dashboardWindow || dashboardWindow.isDestroyed()) return false;
        const found = await safeExecuteJS(`!!document.querySelector('${selector}')`, 3000);
        if (found) return true;
        await delay(500);
    }
    return false;
}

async function login() {
    if (config.mode === 'window') dashboardWindow.show();
    updateState('action', 'Authorizing...');
    console.log('[LOGIN] Starting login flow...');

    try {
        const loadPromise1 = waitForLoad(dashboardWindow, 20000);
        await safeExecuteJS(`
            var btn = document.querySelector('button');
            if (btn) btn.click();
        `, 5000);

        if (!running) return false;
        console.log('[LOGIN] Waiting for Gitea page...');
        updateState('action', 'Waiting for Gitea...');
        await loadPromise1;
        await delay(2000);
        console.log('[LOGIN] Landed on:', dashboardWindow.webContents.getURL());

        if (!running) return false;
        updateState('action', 'Looking for login button...');
        const hasExternalLink = await waitForSelector('a.external-login-link', 8000);
        console.log('[LOGIN] External login link found:', hasExternalLink);

        if (hasExternalLink) {
            if (!running) return false;
            const loadPromise2 = waitForLoad(dashboardWindow, 20000);
            await safeExecuteJS(`document.querySelector('a.external-login-link').click()`, 5000);

            console.log('[LOGIN] Waiting for SSO page...');
            updateState('action', 'Waiting for SSO...');
            await loadPromise2;
            await delay(2000);
            console.log('[LOGIN] Landed on:', dashboardWindow.webContents.getURL());
        }

        if (!running) return false;
        updateState('action', 'Filling form...');
        const hasPass = await waitForSelector('input[type="password"]', 10000);
        console.log('[LOGIN] Password field found:', hasPass);

        if (hasPass) {
            const creds = JSON.stringify({ e: config.email, p: config.password });
            const loadPromise3 = waitForLoad(dashboardWindow, 30000);
            await safeExecuteJS(`
                (function() {
                    var c = ${creds};
                    var u = document.querySelector('input[name="login"]') ||
                              document.querySelector('input[name="username"]') ||
                              document.querySelector('input[name="email"]') ||
                              document.querySelector('input[type="text"]');
                    var p = document.querySelector('input[type="password"]');
                    var s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                    if (u) {
                        s.call(u, c.e);
                        u.dispatchEvent(new Event('input', {bubbles:true}));
                        u.dispatchEvent(new Event('change', {bubbles:true}));
                    }
                    if (p) {
                        s.call(p, c.p);
                        p.dispatchEvent(new Event('input', {bubbles:true}));
                        p.dispatchEvent(new Event('change', {bubbles:true}));
                        setTimeout(function() {
                            var btn = document.querySelector('button[type="submit"]') ||
                                      document.querySelector('input[type="submit"]');
                            if (btn) { btn.click(); return; }
                            var f = p.closest('form');
                            if (f) { f.method = 'POST'; f.submit(); }
                        }, 600);
                    }
                })();
            `, 5000);

            console.log('[LOGIN] Waiting for redirect...');
            updateState('action', 'Waiting for redirect...');
            await loadPromise3;
            await delay(2000);
            console.log('[LOGIN] Landed on:', dashboardWindow.webContents.getURL());
        }

        if (await checkAuth()) {
            console.log('[LOGIN] Authenticated!');
            return true;
        }

        console.log('[LOGIN] Polling for auth (30s)...');
        const authStart = Date.now();
        while (Date.now() - authStart < 30000 && running) {
            await delay(2000);
            if (await checkAuth()) {
                console.log('[LOGIN] Authenticated via polling!');
                return true;
            }
        }
    } catch (e) {
        console.error('[LOGIN] Error:', e.message);
    }

    if (!running) return false;

    console.log('[LOGIN] Fallback: manual login');
    updateState('action', 'Sign in manually in the window that opened...');
    if (config.mode === 'window') dashboardWindow.show();

    const fallbackStart = Date.now();
    while (Date.now() - fallbackStart < 120000 && running) {
        await delay(3000);
        if (await checkAuth()) return true;
    }

    return false;
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

async function startActivityLoop() {
    if (!running || !dashboardWindow || dashboardWindow.isDestroyed()) return;

    try {
        const url = dashboardWindow.webContents.getURL();
        if (!url.toLowerCase().includes('dashboard')) {
            updateState('action', 'Returning to dashboard');
            dashboardWindow.loadURL(config.url);
            await waitForLoad(dashboardWindow, 15000);
            await delay(2000);
        }

        const action = randomInt(0, 4);
        let actionLabel = null;
        switch (action) {
            case 0:
                await safeExecuteJS(`
                    document.dispatchEvent(new MouseEvent('mousemove', {
                        clientX: ${randomInt(100, 1800)},
                        clientY: ${randomInt(100, 900)}
                    }));
                `, 5000);
                actionLabel = 'Mouse movement';
                break;
            case 1:
                await safeExecuteJS(`
                    window.scrollBy(0, ${(Math.random() < 0.5 ? 1 : -1) * randomInt(50, 300)});
                `, 5000);
                actionLabel = 'Page scroll';
                break;
            case 2:
                await safeExecuteJS(`
                    window.scrollBy(0, ${(Math.random() < 0.5 ? 1 : -1) * randomInt(10, 50)});
                `, 5000);
                actionLabel = 'Micro-scroll';
                break;
            case 3:
                await safeExecuteJS(`
                    (function() {
                        var buttons = document.querySelectorAll('button:not([disabled]), a:not([href="#"]), [role="button"]');
                        if (buttons.length > 0) {
                            var btn = buttons[Math.floor(Math.random() * Math.min(buttons.length, 10))];
                            var text = (btn.innerText || '').toLowerCase();
                            if (!['logout','exit','sign out','выйти','выход'].some(function(s) { return text.includes(s); })) {
                                btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                setTimeout(function() { btn.click(); }, 500);
                            }
                        }
                    })();
                `, 5000);
                actionLabel = 'Click';
                break;
            case 4:
                await safeExecuteJS(`
                    if (document.activeElement) document.activeElement.blur();
                    window.focus();
                `, 5000);
                actionLabel = 'Focus change';
                break;
        }
        // Only surface activity text while time is actually being credited;
        // otherwise leave the "Not counting" message visible.
        if (actionLabel && healthState.health === HEALTH.COUNTING) {
            updateState('action', actionLabel);
        }
    } catch (e) {
        if (healthState.health === HEALTH.COUNTING) {
            updateState('action', 'Error: ' + e.message);
        }
    }

    if (running) {
        activityTimer = setTimeout(startActivityLoop, randomInt(2000, 8000));
    }
}

function scheduleRefresh() {
    const interval = randomInt(300, 600) * 1000;
    refreshTimer = setTimeout(async () => {
        if (!running || !dashboardWindow || dashboardWindow.isDestroyed()) return;
        try {
            updateState('action', 'Page refresh');
            dashboardWindow.reload();
            await waitForLoad(dashboardWindow, 15000);
            await delay(2000);
            scheduleRefresh();
        } catch {
            updateState('action', 'Refresh error');
        }
    }, interval);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForLoad(win, timeout = 30000) {
    return new Promise((resolve) => {
        let resolved = false;
        const handler = () => {
            if (resolved) return;
            resolved = true;
            resolve();
        };
        win.webContents.once('did-finish-load', handler);
        setTimeout(handler, timeout);
    });
}

ipcMain.handle('get-state', () => state);
ipcMain.on('start-bot', () => startBot());
ipcMain.on('stop-bot', () => stopBot());
ipcMain.on('show-dashboard', () => showDashboard());
ipcMain.on('set-mode', (_, mode) => {
    const clean = settingsStore.sanitize({ mode }).mode || 'api';
    config.mode = clean;
    settingsStore.saveSettings({ mode: clean });
    updateState('mode', clean);
    if (running) {
        stopBot().then(() => startBot()).catch((e) => updateState('action', e.message));
    }
});
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
    createDashboardWindow();
    setTimeout(startBot, 2000);
}

async function logout() {
    // 1. Stop tracking first — needs the live dashboard window + session to POST stop.
    await stopBot();
    // 2. Forget credentials (settings are preserved by config-store merge).
    credentials.clear();
    // 3. Clear the dashboard web session so a different account starts fresh.
    try {
        await session.fromPartition('persist:dashboard').clearStorageData();
    } catch (e) {
        console.error('[LOGOUT] clearStorageData failed:', e.message);
    }
    // 4. Drop the dashboard window so the next login rebuilds it with a clean session.
    if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.destroy();
    dashboardWindow = null;
    // 4b. Forget the previous account's tracking session so the next login starts clean.
    trackingState = { deviceId: '', fingerprint: '', active: false, challengePending: false, csrfToken: '' };
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

function resolveMode() {
    const raw = readConfig(settingsStore.configPath());
    if (raw.mode) {
        config.mode = settingsStore.withDefaults(raw).mode;
    } else {
        // Back-compat: honor the old HEADLESS=true env only when nothing was saved.
        config.mode = process.env.HEADLESS === 'true' ? 'background' : 'api';
    }
    state.mode = config.mode;
}

app.whenReady().then(() => {
    resolveMode();
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
        clearTimeout(activityTimer);
        clearTimeout(refreshTimer);
        clearTimeout(heartbeatTimer);
        stopDurationTimer();
        Promise.race([
            backend.stop(4000),
            new Promise((resolve) => setTimeout(resolve, 5000)),
        ]).finally(() => app.quit());
    }
});
