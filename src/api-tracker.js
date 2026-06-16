// Browserless tracking backend: performs the Gitea OAuth flow and tracking
// heartbeats over plain HTTP (no BrowserWindow). Ported from time-monitor.js.
const axios = require('axios');
const { generateFingerprint } = require('./utils');
const { GITEA_URL } = require('./endpoints');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const OAUTH_CLIENT_ID = '9054c6e8-99da-4ee6-a261-efd9b2ae5357';

function createApiTracker(opts) {
    const dashboardUrl = opts.dashboardUrl;
    const getCredentials = opts.getCredentials;
    const request = opts.request || axios;

    const cookies = new Map();
    let csrfToken = '';
    let deviceId = '';
    let fingerprint = '';
    let active = false;

    function extractCookies(response) {
        const setCookies = (response.headers && response.headers['set-cookie']) || [];
        setCookies.forEach((cookie) => {
            const match = cookie.match(/^([^=]+)=([^;]+)/);
            if (match) cookies.set(match[1], match[2]);
        });
    }

    function getCookieString() {
        return Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    async function makeRequest(url, options = {}) {
        const headers = {
            'User-Agent': USER_AGENT,
            'Cookie': getCookieString(),
            ...options.headers,
        };
        if (csrfToken) headers['x-csrf-token'] = csrfToken;
        const cfg = { timeout: 15000, url, ...options, headers, validateStatus: () => true };
        if (options.maxRedirects === 0) cfg.maxRedirects = 0;
        const response = await request(cfg);
        extractCookies(response);
        return response;
    }

    async function startOAuth() {
        const response = await makeRequest(
            `${dashboardUrl}/api/v1/auth/gitea/start?returnTo=${encodeURIComponent(dashboardUrl)}/`,
            { maxRedirects: 0 }
        );
        const location = response.headers && response.headers.location;
        if (!location) throw new Error(`OAuth start failed (status ${response.status})`);
        const match = location.match(/state=([^&]+)/);
        if (!match) throw new Error('Failed to extract OAuth state');
        return match[1];
    }

    async function loginToGitea(state, email, password) {
        const loginUrl = `${GITEA_URL}/user/login`;
        await makeRequest(loginUrl); // seed Gitea session cookie
        const loginResponse = await makeRequest(loginUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            data: `user_name=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`,
            maxRedirects: 0,
        });
        if (![301, 302, 303].includes(loginResponse.status)) {
            throw new Error(`Gitea login failed (status ${loginResponse.status})`);
        }
        const redirectUrl = loginResponse.headers && loginResponse.headers.location;
        let homeUrl = `${GITEA_URL}/`;
        if (redirectUrl) {
            homeUrl = redirectUrl.startsWith('http') ? redirectUrl : `${GITEA_URL}${redirectUrl}`;
        }
        await makeRequest(homeUrl);

        const oauthUrl = `${GITEA_URL}/login/oauth/authorize?client_id=${OAUTH_CLIENT_ID}` +
            `&redirect_uri=${encodeURIComponent(dashboardUrl)}/api/v1/auth/gitea/callback` +
            `&response_type=code&scope=user&state=${state}`;
        const oauthResponse = await makeRequest(oauthUrl, { maxRedirects: 0 });
        const callbackUrl = oauthResponse.headers && oauthResponse.headers.location;
        if (!callbackUrl) throw new Error(`OAuth authorize failed (status ${oauthResponse.status})`);

        // Manually follow redirects so every Set-Cookie is captured.
        let currentUrl = callbackUrl.startsWith('/') ? `${dashboardUrl}${callbackUrl}` : callbackUrl;
        let redirects = 0;
        while (redirects < 10) {
            const response = await makeRequest(currentUrl, { maxRedirects: 0 });
            if ([301, 302, 307, 308].includes(response.status)) {
                const location = response.headers && response.headers.location;
                if (!location) break;
                const parsed = new URL(currentUrl);
                if (location.startsWith('/')) currentUrl = `${parsed.protocol}//${parsed.host}${location}`;
                else if (location.startsWith('http')) currentUrl = location;
                else currentUrl = `${parsed.protocol}//${parsed.host}/${location}`;
                redirects++;
            } else {
                break;
            }
        }
    }

    async function checkAuth() {
        const response = await makeRequest(`${dashboardUrl}/api/v1/auth/me`);
        if (response.status !== 200) return false;
        const data = response.data || {};
        if (data.authenticated && data.csrfToken) {
            csrfToken = data.csrfToken;
            return true;
        }
        return false;
    }

    async function ensureAuth() {
        if (await checkAuth()) return true;
        const { email, password } = getCredentials() || {};
        if (!email || !password) return false;
        const state = await startOAuth();
        await loginToGitea(state, email, password);
        return await checkAuth();
    }

    async function ensureStarted() {
        deviceId = `keeper-api-${Date.now()}`;
        fingerprint = generateFingerprint(deviceId);
        const response = await makeRequest(`${dashboardUrl}/api/v1/tracking/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: { deviceId, deviceName: 'Activity Keeper', fingerprint },
        });
        if (response.status !== 200) {
            throw new Error(`start failed (${response.status}): ${(response.data && response.data.error) || 'unknown'}`);
        }
        const returned = (response.data && response.data.tracking && response.data.tracking.deviceId) || deviceId;
        deviceId = returned;
        active = true;
    }

    async function fetchProgress() {
        // The heartbeat response does not carry today/week hours; those live on
        // the dashboard endpoint under `hours` (matches the dashboard API).
        const response = await makeRequest(`${dashboardUrl}/api/v1/dashboard`);
        if (response.status !== 200) return {};
        const hours = (response.data && response.data.hours) || {};
        return { todaySeconds: hours.todaySeconds, weekSeconds: hours.weekSeconds };
    }

    async function heartbeat() {
        const response = await makeRequest(`${dashboardUrl}/api/v1/tracking/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: { deviceId, fingerprint },
        });
        if (response.status !== 200) throw new Error(`heartbeat failed (${response.status})`);
        const data = response.data || {};
        const tracking = data.tracking || {};
        // todaySeconds/weekSeconds may arrive at the top level or nested under
        // `tracking`; challengePending is only ever nested under `tracking`
        // (matches the dashboard API and src/main.js heartbeat handling).
        let todaySeconds = data.todaySeconds != null ? data.todaySeconds : tracking.todaySeconds;
        let weekSeconds = data.weekSeconds != null ? data.weekSeconds : tracking.weekSeconds;
        // Heartbeat usually omits hours — fall back to the dashboard endpoint.
        if (todaySeconds == null || weekSeconds == null) {
            const progress = await fetchProgress();
            if (todaySeconds == null) todaySeconds = progress.todaySeconds;
            if (weekSeconds == null) weekSeconds = progress.weekSeconds;
        }
        return {
            todaySeconds,
            weekSeconds,
            challengePending: !!tracking.challengePending,
        };
    }

    async function stop() {
        if (!active || !deviceId) return;
        try {
            await makeRequest(`${dashboardUrl}/api/v1/tracking/stop`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                data: { deviceId, fingerprint },
            });
        } catch (e) {
            // best-effort stop
        }
        active = false;
    }

    function isAvailable() { return cookies.size > 0; }
    function isStarted() { return active; }
    async function recover() { active = false; return ensureAuth(); }
    function reset() { cookies.clear(); csrfToken = ''; deviceId = ''; fingerprint = ''; active = false; }

    return { ensureAuth, ensureStarted, heartbeat, fetchProgress, stop, isAvailable, isStarted, recover, reset };
}

module.exports = { createApiTracker, GITEA_URL, OAUTH_CLIENT_ID };
