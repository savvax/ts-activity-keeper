const { test } = require("node:test");
const assert = require("node:assert");
const { createApiTracker } = require("../src/api-tracker");

// Scripted fake HTTP client: first matching route wins; records every call.
function makeFakeRequest(routes) {
	async function request(cfg) {
		request.calls.push(cfg);
		const route = routes.find((r) => r.match(cfg));
		if (!route)
			throw new Error(`no route for ${cfg.method || "GET"} ${cfg.url}`);
		return route.response(cfg);
	}
	request.calls = [];
	return request;
}

test("heartbeat maps response to {todaySeconds, weekSeconds, challengePending}", async () => {
	const request = makeFakeRequest([
		{
			match: (c) => c.url.includes("/tracking/heartbeat"),
			response: () => ({
				status: 200,
				headers: {},
				data: {
					tracking: {
						todaySeconds: 120,
						weekSeconds: 300,
						challengePending: true,
					},
				},
			}),
		},
	]);
	const t = createApiTracker({
		dashboardUrl: "https://d",
		getCredentials: () => ({}),
		request,
	});
	assert.deepStrictEqual(await t.heartbeat(), {
		todaySeconds: 120,
		weekSeconds: 300,
		challengePending: true,
	});
});

test("ensureAuth returns false when credentials are missing", async () => {
	const request = makeFakeRequest([
		{
			match: (c) => c.url.includes("/auth/me"),
			response: () => ({
				status: 200,
				headers: {},
				data: { authenticated: false },
			}),
		},
	]);
	const t = createApiTracker({
		dashboardUrl: "https://d",
		getCredentials: () => ({ email: "", password: "" }),
		request,
	});
	assert.strictEqual(await t.ensureAuth(), false);
});

test("ensureAuth runs the full OAuth flow, captures and forwards cookies", async () => {
	let authed = false;
	const request = makeFakeRequest([
		{
			match: (c) => c.url.includes("/auth/me"),
			response: () =>
				authed
					? {
							status: 200,
							headers: {},
							data: { authenticated: true, csrfToken: "csrf-1" },
						}
					: { status: 200, headers: {}, data: { authenticated: false } },
		},
		{
			match: (c) => c.url.includes("/auth/gitea/start"),
			response: () => ({
				status: 302,
				headers: {
					location:
						"https://01.tomorrow-school.ai/git/login/oauth/authorize?state=ST8&x=1",
					"set-cookie": ["dash=1; Path=/"],
				},
				data: "",
			}),
		},
		{
			match: (c) =>
				c.url.endsWith("/user/login") && (c.method || "GET") === "GET",
			response: () => ({
				status: 200,
				headers: { "set-cookie": ["gitea=sess; Path=/"] },
				data: "",
			}),
		},
		{
			match: (c) => c.url.endsWith("/user/login") && c.method === "POST",
			response: () => ({ status: 303, headers: { location: "/" }, data: "" }),
		},
		{
			match: (c) => c.url === "https://01.tomorrow-school.ai/git/",
			response: () => ({ status: 200, headers: {}, data: "" }),
		},
		{
			match: (c) => c.url.includes("/login/oauth/authorize"),
			response: () => ({
				status: 302,
				headers: {
					location: "https://d/api/v1/auth/gitea/callback?code=CODE&state=ST8",
				},
				data: "",
			}),
		},
		{
			match: (c) => c.url.includes("/auth/gitea/callback"),
			response: () => {
				authed = true;
				return {
					status: 302,
					headers: { location: "/", "set-cookie": ["session=abc; Path=/"] },
					data: "",
				};
			},
		},
		{
			match: (c) => c.url === "https://d/",
			response: () => ({ status: 200, headers: {}, data: "" }),
		},
	]);
	const t = createApiTracker({
		dashboardUrl: "https://d",
		getCredentials: () => ({ email: "a@b.c", password: "pw" }),
		request,
	});

	assert.strictEqual(await t.ensureAuth(), true);
	assert.strictEqual(t.isAvailable(), true);

	// Cookie jar accumulates and is forwarded: the authorize GET carries the gitea session cookie.
	const authorizeCall = request.calls.find((c) =>
		c.url.includes("/login/oauth/authorize"),
	);
	assert.ok(
		authorizeCall.headers.Cookie.includes("gitea=sess"),
		"authorize request should carry gitea cookie",
	);
});

test("ensureStarted marks active and adopts the server-assigned deviceId", async () => {
	const request = makeFakeRequest([
		{
			match: (c) => c.url.includes("/tracking/start"),
			response: () => ({
				status: 200,
				headers: {},
				data: { tracking: { deviceId: "srv-123" } },
			}),
		},
		{
			match: (c) => c.url.includes("/tracking/heartbeat"),
			response: () => ({
				status: 200,
				headers: {},
				data: {
					tracking: {
						todaySeconds: 1,
						weekSeconds: 2,
						challengePending: false,
					},
				},
			}),
		},
	]);
	const t = createApiTracker({
		dashboardUrl: "https://d",
		getCredentials: () => ({}),
		request,
	});
	assert.strictEqual(t.isStarted(), false);
	await t.ensureStarted();
	assert.strictEqual(t.isStarted(), true);
	await t.heartbeat();
	const hbCall = request.calls.find((c) =>
		c.url.includes("/tracking/heartbeat"),
	);
	assert.strictEqual(hbCall.data.deviceId, "srv-123");
});

test("loginToGitea follows an absolute post-login Location without mangling it", async () => {
	let authed = false;
	const request = makeFakeRequest([
		{
			match: (c) => c.url.includes("/auth/me"),
			response: () =>
				authed
					? {
							status: 200,
							headers: {},
							data: { authenticated: true, csrfToken: "csrf-1" },
						}
					: { status: 200, headers: {}, data: { authenticated: false } },
		},
		{
			match: (c) => c.url.includes("/auth/gitea/start"),
			response: () => ({
				status: 302,
				headers: {
					location:
						"https://01.tomorrow-school.ai/git/login/oauth/authorize?state=ST9",
				},
				data: "",
			}),
		},
		{
			match: (c) =>
				c.url.endsWith("/user/login") && (c.method || "GET") === "GET",
			response: () => ({ status: 200, headers: {}, data: "" }),
		},
		{
			match: (c) => c.url.endsWith("/user/login") && c.method === "POST",
			response: () => ({
				status: 303,
				headers: { location: "https://01.tomorrow-school.ai/git/dashboard" },
				data: "",
			}),
		},
		{
			match: (c) => c.url === "https://01.tomorrow-school.ai/git/dashboard",
			response: () => ({ status: 200, headers: {}, data: "" }),
		},
		{
			match: (c) => c.url.includes("/login/oauth/authorize"),
			response: () => ({
				status: 302,
				headers: { location: "https://d/api/v1/auth/gitea/callback?state=ST9" },
				data: "",
			}),
		},
		{
			match: (c) => c.url.includes("/auth/gitea/callback"),
			response: () => {
				authed = true;
				return { status: 302, headers: { location: "/" }, data: "" };
			},
		},
		{
			match: (c) => c.url === "https://d/",
			response: () => ({ status: 200, headers: {}, data: "" }),
		},
	]);
	const t = createApiTracker({
		dashboardUrl: "https://d",
		getCredentials: () => ({ email: "a@b.c", password: "pw" }),
		request,
	});
	assert.strictEqual(await t.ensureAuth(), true);
	assert.ok(
		request.calls.some(
			(c) => c.url === "https://01.tomorrow-school.ai/git/dashboard",
		),
		"absolute redirect requested as-is",
	);
	assert.ok(
		!request.calls.some((c) => c.url.includes("githttps")),
		"absolute Location must not be concatenated onto GITEA_URL",
	);
});

test("pairAgent reads {machineId, token} from the local agent and POSTs to /agent/pair", async () => {
	const request = makeFakeRequest([
		{
			match: (c) => c.url === "http://127.0.0.1:47836/pair-info",
			response: () => ({
				status: 200,
				headers: {},
				data: { machineId: "mac-42", token: "tok-1" },
			}),
		},
		{
			match: (c) => c.url.includes("/agent/pair"),
			response: () => ({ status: 200, headers: {}, data: {} }),
		},
	]);
	const t = createApiTracker({
		dashboardUrl: "https://d",
		getCredentials: () => ({}),
		request,
	});
	const res = await t.pairAgent();
	assert.deepStrictEqual(res, { paired: true, machineId: "mac-42" });
	const pairCall = request.calls.find((c) => c.url.includes("/agent/pair"));
	assert.strictEqual(pairCall.method, "POST");
	assert.deepStrictEqual(pairCall.data, {
		machineId: "mac-42",
		token: "tok-1",
	});
});

test("pairAgent reports agent-unreachable when the local agent is down (ECONNREFUSED)", async () => {
	const request = makeFakeRequest([
		{
			match: (c) => c.url === "http://127.0.0.1:47836/pair-info",
			response: () => {
				throw new Error("connect ECONNREFUSED 127.0.0.1:47836");
			},
		},
	]);
	const t = createApiTracker({
		dashboardUrl: "https://d",
		getCredentials: () => ({}),
		request,
	});
	const res = await t.pairAgent();
	assert.strictEqual(res.paired, false);
	assert.strictEqual(res.reason, "agent-unreachable");
});

test("pairAgent reports no-machine-id when the agent responds without machineId", async () => {
	const request = makeFakeRequest([
		{
			match: (c) => c.url === "http://127.0.0.1:47836/pair-info",
			response: () => ({ status: 200, headers: {}, data: { token: "tok-1" } }),
		},
	]);
	const t = createApiTracker({
		dashboardUrl: "https://d",
		getCredentials: () => ({}),
		request,
	});
	const res = await t.pairAgent();
	assert.strictEqual(res.paired, false);
	assert.strictEqual(res.reason, "no-machine-id");
});

test("pairAgent does not leak the dashboard session cookie to the local agent", async () => {
	const request = makeFakeRequest([
		{
			match: (c) => c.url === "http://127.0.0.1:47836/pair-info",
			response: () => ({ status: 200, headers: {}, data: { machineId: "m1" } }),
		},
		{
			match: (c) => c.url.includes("/agent/pair"),
			response: () => ({ status: 200, headers: {}, data: {} }),
		},
	]);
	const t = createApiTracker({
		dashboardUrl: "https://d",
		getCredentials: () => ({}),
		request,
	});
	await t.pairAgent();
	const infoCall = request.calls.find(
		(c) => c.url === "http://127.0.0.1:47836/pair-info",
	);
	assert.ok(
		!infoCall.headers.Cookie,
		"pair-info request must not carry the session cookie to the local agent",
	);
});

test("pairAgent accepts a JSON body served as text", async () => {
	const request = makeFakeRequest([
		{
			match: (c) => c.url === "http://127.0.0.1:47836/pair-info",
			response: () => ({
				status: 200,
				headers: {},
				data: '{"machineId":"mac-9","token":"t9"}',
			}),
		},
		{
			match: (c) => c.url.includes("/agent/pair"),
			response: () => ({ status: 200, headers: {}, data: {} }),
		},
	]);
	const t = createApiTracker({
		dashboardUrl: "https://d",
		getCredentials: () => ({}),
		request,
	});
	const res = await t.pairAgent();
	assert.deepStrictEqual(res, { paired: true, machineId: "mac-9" });
});
