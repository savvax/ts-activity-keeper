// Electron main process: headless-демон без единого окна и иконки.
// Всё общение с человеком идёт через Telegram (`telegram-bot.js`); здесь
// остаётся только оркестрация: трекинг-цикл, health, автостоп, keep-awake,
// автозапуск и wiring хендлеров бота.

const { app, powerSaveBlocker } = require("electron");
const { execFile } = require("child_process");
const axios = require("axios");
const {
	randomInt,
	formatDuration,
	formatSeconds,
	maskLogin,
} = require("./utils");
const credentials = require("./credentials");
const {
	HEALTH,
	initialHealthState,
	deriveHealth,
} = require("./tracking-health");
const { createSessionClock } = require("./session-clock");
const { createReminder } = require("./reminder");
const { createAutoStop } = require("./auto-stop");
const { createTelegramBot } = require("./telegram-bot");
const { createKeepAwake } = require("./keep-awake");
const { ensureAutostart, describeAutostart } = require("./launch-agent");
const { loadBuildSecrets } = require("./build-config-loader");
const settingsStore = require("./settings");
const { createApiTracker } = require("./api-tracker");
const { DEFAULT_DASHBOARD_URL } = require("./endpoints");

require("dotenv").config();

const VERSION = require("../package.json").version;
const secrets = loadBuildSecrets();
const startedAt = Date.now();

const config = {
	email: "",
	password: "",
	url: process.env.DASHBOARD_URL || DEFAULT_DASHBOARD_URL,
};

let running = false;
let durationTimer = null;
let heartbeatTimer = null;
let heartbeatErrors = 0;
let recoveryAttempts = 0;
let isQuitting = false;
let autostartResult = null;
// Поколение heartbeat-цепочки: инкрементируется в startHeartbeatLoop(), чтобы
// зависшая после /pause итерация (или дубль от быстрого /pause+/resume) себя
// узнала по несовпадению gen и молча остановилась, не трогая backend.
let runGen = 0;

// Спаривание с локальным TS-агентом (127.0.0.1:47836). Без него сервер не
// зачисляет время. Burst из 12 попыток по 5 с (как в дашборде), затем ленивый
// ретрай каждые 60 с, пока агент не появится.
let pairingTimer = null;
let pairingAttempts = 0;
let pairingNotifiedMissing = false;
const PAIR_MAX_ATTEMPTS = 12;
const PAIR_INTERVAL_MS = 5000;
const PAIR_LAZY_INTERVAL_MS = 60000;

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

const state = {
	status: "Остановлен",
	action: "-",
	duration: "00:00:00",
	today: "--:--:--",
	week: "--:--:--",
	challenge: false,
	paired: false, // проспарена ли сессия с локальным TS-агентом
	machine: "-", // machineId агента после спаривания
	autoStopRemaining: null, // 'HH:MM:SS' пока автостоп взведён
};

// Сырой логин никогда не покидает main: всё пользовательское идёт через это.
function displayEmail() {
	if (!config.email) return "";
	return settingsStore.loadSettings().hideLogin
		? maskLogin(config.email)
		: config.email;
}

const apiBackend = createApiTracker({
	dashboardUrl: config.url,
	getCredentials: () => ({ email: config.email, password: config.password }),
});

const backend = apiBackend;

// ---- Трекинг ---------------------------------------------------------------

async function startBot() {
	if (running) return "Трекинг уже идёт.";
	if (!config.email || !config.password)
		return "Нет аккаунта. Войди: /login <email> <пароль>";

	running = true;
	healthState = initialHealthState();
	sessionClock.reset();
	recoveryAttempts = 0;
	if (reminder) reminder.stop();
	armAutoStop();
	startDurationTimer();
	state.status = "Запускается";
	state.action = "Авторизация...";

	try {
		apiBackend.reset();
		const ok = await apiBackend.ensureAuth();
		if (!ok) {
			failStart("Авторизация не удалась — проверь логин и пароль");
			return "Авторизация не удалась.";
		}
		state.status = "Активен";
		state.action = "Запуск трекинга...";
		startPairingLoop();
		startHeartbeatLoop();
		return "Трекинг запускается.";
	} catch (e) {
		failStart(e.message);
		return "Ошибка запуска: " + e.message;
	}
}

function failStart(message) {
	state.status = "Ошибка";
	state.action = message;
	running = false;
	stopDurationTimer();
	autoStop.disarm();
	state.autoStopRemaining = null;
	telegramNotify("❌ Ошибка авторизации: " + message);
}

async function stopBot() {
	running = false;
	clearTimeout(heartbeatTimer);
	stopPairingLoop();
	pairingNotifiedMissing = false;
	applyPairing(false, null);
	stopDurationTimer();
	if (reminder) reminder.stop();
	autoStop.disarm();
	state.autoStopRemaining = null;
	sessionClock.reset();
	healthState = initialHealthState();

	state.status = "Остановлен";
	state.action = "Остановка трекинга...";

	await backend.stop();

	trackingState.challengePending = false;
	state.action = "-";
	state.duration = "00:00:00";
	state.challenge = false;
}

function updateProgress(todaySeconds, weekSeconds) {
	if (typeof todaySeconds === "number")
		state.today = formatSeconds(todaySeconds);
	if (typeof weekSeconds === "number") state.week = formatSeconds(weekSeconds);
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
		state.status = "Активен";
		if (!trackingState.challengePending) state.action = "Время считается";
		if (reminder) reminder.restored();
	} else {
		// stalled, disconnected или connecting, разрешившийся в «не считается»
		sessionClock.pause();
		state.status = "Не считается";
		const msg =
			next.health === HEALTH.STALLED
				? "сервер отвечает, но время не растёт"
				: "нет связи с сервером";
		state.action = msg;
		if (reminder) reminder.notCounting(msg);
	}
}

function startHeartbeatLoop() {
	clearTimeout(heartbeatTimer);
	heartbeatErrors = 0;
	const gen = ++runGen;
	heartbeatLoop(gen);
}

// `gen` pins this call chain to the heartbeat generation it was started
// under. /pause bumps `running` false immediately but a chain already past
// an `await` only notices on its next check — the gen check additionally
// catches a fast /pause+/resume, where a new chain (new gen) starts while
// the old one is still in flight; every await is followed by a
// `!running || gen !== runGen` check so a stale chain never touches the
// backend (no ensureStarted/heartbeat/recover) and never reschedules itself.
async function heartbeatLoop(gen) {
	if (!running || gen !== runGen) return;

	if (!backend.isAvailable()) {
		processHealth({ hbOk: false, today: null });
		if (running && gen === runGen)
			heartbeatTimer = setTimeout(
				() => heartbeatLoop(gen),
				heartbeatInterval(),
			);
		return;
	}

	// Часы за день/неделю приходят с дашборда и доступны, даже когда трекинг
	// не идёт — тянем их отдельно от heartbeat.
	if (typeof backend.fetchProgress === "function") {
		try {
			const progress = await backend.fetchProgress();
			if (!running || gen !== runGen) return;
			if (progress) updateProgress(progress.todaySeconds, progress.weekSeconds);
		} catch (e) {
			// best-effort, цикл не ломаем
		}
	}

	if (!running || gen !== runGen) return;

	if (!backend.isStarted()) {
		try {
			await backend.ensureStarted();
		} catch (e) {
			console.error("[TRACKING] Re-start failed:", e.message);
		}
		if (!running || gen !== runGen) return;
	}

	try {
		const hb = await backend.heartbeat();
		if (!running || gen !== runGen) return;
		heartbeatErrors = 0;
		recoveryAttempts = 0;
		let today = null;
		if (hb) {
			updateProgress(hb.todaySeconds, hb.weekSeconds);
			if (typeof hb.todaySeconds === "number") today = hb.todaySeconds;
			console.log(
				`[TRACKING] heartbeat ok: today=${hb.todaySeconds}s week=${hb.weekSeconds}s challenge=${hb.challengePending}`,
			);
			setChallenge(!!hb.challengePending);
		}
		processHealth({ hbOk: true, today });
	} catch (e) {
		if (!running || gen !== runGen) return;
		heartbeatErrors++;
		console.error(
			`[TRACKING] Heartbeat error (${heartbeatErrors}/3):`,
			e.message,
		);
		processHealth({ hbOk: false, today: null });
		if (heartbeatErrors >= 3) {
			heartbeatErrors = 0;
			if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
				console.error(
					`[TRACKING] Recovery attempts exhausted (${recoveryAttempts})`,
				);
				state.action = "Ошибка трекинга — нужна проверка";
				telegramNotify(
					"🛑 Восстановить трекинг не удалось — нужна проверка вручную на Маке.",
				);
			} else {
				recoveryAttempts++;
				console.log(
					`[TRACKING] Recovering (attempt ${recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS})...`,
				);
				state.action = "Восстановление трекинга...";
				try {
					await backend.recover();
				} catch (recoveryErr) {
					console.error("[TRACKING] Recovery failed:", recoveryErr.message);
				}
				if (!running || gen !== runGen) return;
			}
		}
	}

	if (running && gen === runGen) {
		heartbeatTimer = setTimeout(() => heartbeatLoop(gen), heartbeatInterval());
	}
}

// ---- Спаривание с локальным TS-агентом -------------------------------------
// Сервер не зачисляет время, пока сессия не проспарена с локальным агентом
// (127.0.0.1:47836). Дашборд делает это из браузера (что и вызывает промпт
// «wants to access other apps and services»); нативный демон повторяет те же
// вызовы сам — браузер и ручной «allow» больше не нужны.
function applyPairing(paired, machineId) {
	state.paired = !!paired;
	state.machine = paired ? machineId || "?" : "-";
}

function startPairingLoop() {
	stopPairingLoop();
	pairingAttempts = 0;
	pairingTick().catch((e) =>
		console.error("[PAIR] pairingTick start failed:", e.message),
	);
}

function stopPairingLoop() {
	if (pairingTimer) {
		clearTimeout(pairingTimer);
		pairingTimer = null;
	}
}

async function pairingTick() {
	if (!running) return;
	pairingAttempts++;
	let result;
	try {
		result = await apiBackend.pairAgent();
	} catch (e) {
		result = { paired: false, reason: "error" };
		console.error("[PAIR] pairAgent threw:", e.message);
	}
	if (!running) return;

	if (result.paired) {
		const restored = pairingNotifiedMissing;
		applyPairing(true, result.machineId);
		pairingNotifiedMissing = false;
		console.log(`[PAIR] paired with agent: ${result.machineId}`);
		if (restored)
			telegramNotify(
				"✅ Спарен с локальным агентом TS — время снова зачисляется.",
			);
		return; // успех: цикл не перезапускаем
	}

	applyPairing(false, null);
	if (pairingAttempts < PAIR_MAX_ATTEMPTS) {
		// burst: каждые 5 с, как дашборд
		pairingTimer = setTimeout(
			() => pairingTick().catch(() => {}),
			PAIR_INTERVAL_MS,
		);
	} else {
		// burst исчерпан: уведомляем один раз и уходим в ленивый ретрай
		if (!pairingNotifiedMissing) {
			pairingNotifiedMissing = true;
			console.error("[PAIR] local TS agent not found on 127.0.0.1:47836");
			telegramNotify(
				"⚠️ Локальный агент TS не найден (127.0.0.1:47836). Время не зачисляется, пока не запущен официальный агент.",
			);
		}
		pairingTimer = setTimeout(
			() => pairingTick().catch(() => {}),
			PAIR_LAZY_INTERVAL_MS,
		);
	}
}

// Капча: сообщаем один раз на переход false -> true.
function setChallenge(pending) {
	const was = trackingState.challengePending;
	trackingState.challengePending = pending;
	state.challenge = pending;
	if (pending) {
		state.action = "Капча — нужна проверка";
		if (!was)
			telegramNotify(
				"🤖 Требуется проверка (капча) — зайди на дашборд с Мака.",
			);
	}
}

function startDurationTimer() {
	stopDurationTimer();
	durationTimer = setInterval(() => {
		state.autoStopRemaining = autoStop.isArmed()
			? formatDuration(autoStop.remainingMs())
			: null;
		state.duration = formatDuration(sessionClock.elapsedMs());
		if (autoStop.expired()) {
			onAutoStopExpired().catch((e) =>
				console.error("[AUTOSTOP] onAutoStopExpired failed:", e.message),
			);
		}
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
	state.autoStopRemaining = autoStop.isArmed()
		? formatDuration(autoStop.remainingMs())
		: null;
}

async function onAutoStopExpired() {
	autoStop.disarm();
	const settings = settingsStore.loadSettings();
	const andLogout = settings.autoStopLogout;
	telegramNotify(
		andLogout
			? "⏱ Сработал автостоп — трекинг остановлен, аккаунт разлогинен."
			: "⏱ Сработал автостоп — трекинг остановлен.",
	);
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
	config.email = "";
	config.password = "";
	state.status = "Остановлен";
	state.action = "-";
	state.today = "--:--:--";
	state.week = "--:--:--";
	state.duration = "00:00:00";
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
	// Возвращает промис уведомления (или undefined, если бота нет) — вызовы,
	// которым результат не нужен, просто игнорируют возврат; фатальный
	// обработчик ниже дожидается его с собственным таймаутом.
	if (telegramBot) return telegramBot.notify(text);
	return undefined;
}

function agentStatusLine() {
	if (!state.paired) return "Агент: не найден";
	const suffix =
		state.machine && state.machine !== "-" ? ` (${state.machine})` : "";
	return `Агент: проспарен${suffix}`;
}

function statusText() {
	const s = settingsStore.loadSettings();
	const lines = [
		`Статус: ${state.status}`,
		`Действие: ${state.action}`,
		`Сессия: ${state.duration}`,
		`Сегодня: ${state.today}`,
		`Неделя: ${state.week}`,
		`Логин: ${displayEmail() || "-"}`,
		`Автостоп: ${
			state.autoStopRemaining
				? `через ${state.autoStopRemaining}${s.autoStopLogout ? " (затем логаут)" : ""}`
				: "выключен"
		}`,
		`Автозапуск: ${describeAutostart(autostartResult)}`,
		`Напоминания: ${s.remindMinutes ? `каждые ${s.remindMinutes} мин` : "выкл"}`,
		agentStatusLine(),
		`Keep-awake: ${describeKeepAwake()}`,
		`Аптайм: ${formatDuration(Date.now() - startedAt)} · версия ${VERSION}`,
	];
	if (state.challenge) lines.push("⚠️ Требуется проверка (капча)");
	return lines.join("\n");
}

function startupText() {
	const trackingLine =
		config.email && config.password
			? "Трекинг: стартует"
			: "Трекинг: ждёт /login <email> <пароль>";
	return [
		`▶️ TS Activity Keeper запущен (v${VERSION})`,
		trackingLine,
		`Автозапуск: ${describeAutostart(autostartResult)}`,
		`Keep-awake: ${describeKeepAwake()}`,
	].join("\n");
}

function createTelegram() {
	telegramBot = createTelegramBot({
		request: (cfg) => axios(cfg),
		getToken: () => secrets.token,
		getSecret: () => secrets.secret,
		getChatId: () => settingsStore.loadSettings().telegramChatId,
		bindChatId: (chatId) =>
			settingsStore.saveSettings({ telegramChatId: chatId }),
		handlers: {
			status: async () => statusText(),
			login: async (email, password) => {
				if (running) await stopBot();

				// Пробуем авторизоваться ДО записи на диск: битая пара не
				// должна сохраниться и не должна переживать перезапуск —
				// иначе автозапуск будет раз за разом долбить сервер тем же
				// неверным паролем (риск блокировки аккаунта).
				const prevEmail = config.email;
				const prevPassword = config.password;
				config.email = email;
				config.password = password;

				let authOk = false;
				try {
					apiBackend.reset();
					authOk = await apiBackend.ensureAuth();
				} catch (e) {
					authOk = false;
				}

				if (!authOk) {
					config.email = prevEmail;
					config.password = prevPassword;
					apiBackend.reset();
					return "Авторизация не удалась — проверь логин и пароль. Аккаунт не сохранён.";
				}

				try {
					credentials.save(email, password);
				} catch (e) {
					return (
						"Авторизация прошла, но не удалось сохранить аккаунт на диск: " +
						e.message
					);
				}

				return await startBot();
			},
			logout: async () => {
				await logout();
				return "Вышел из аккаунта. Войти снова: /login <email> <пароль>";
			},
			pause: async () => {
				await stopBot();
				return "Трекинг остановлен.";
			},
			resume: async () => startBot(),
			autostop: async (minutes, andLogout) => {
				settingsStore.saveSettings({
					autoStopMinutes: minutes,
					autoStopLogout: andLogout,
				});
				if (running) armAutoStop();
				return minutes
					? `Автостоп: через ${minutes} мин${andLogout ? " с логаутом" : ""}.`
					: "Автостоп выключен.";
			},
			autostart: async (on) => {
				settingsStore.saveSettings({ autostart: on });
				autostartResult = safeEnsureAutostart(on);
				return "Автозапуск: " + describeAutostart(autostartResult);
			},
			remind: async (minutes) => {
				settingsStore.saveSettings({ remindMinutes: minutes });
				return minutes
					? `Напоминания: каждые ${minutes} мин.`
					: "Напоминания выключены (сообщения о смене состояния остаются).";
			},
			hidelogin: async () => {
				settingsStore.saveSettings({ hideLogin: true });
				return "Логин теперь маскируется: " + displayEmail();
			},
			quit: async () => {
				// Останавливаем трекинг сначала (сервер должен узнать, что мы
				// ушли), затем зовём app.quit() — оно доедет до before-quit,
				// которое к этому моменту увидит running=false и не станет
				// повторно стопать backend. Таймаут — чтобы зависший stop()
				// не заблокировал выход из приложения навсегда.
				try {
					await Promise.race([
						stopBot(),
						new Promise((resolve) => setTimeout(resolve, 5000)),
					]);
				} catch (e) {
					console.error(
						"[QUIT] Не удалось штатно остановить трекинг:",
						e.message,
					);
				}
				app.quit();
			},
		},
		log: (msg) => console.error("[TELEGRAM]", msg),
	});
	if (secrets.token)
		telegramBot.start(); // висячий long-poll цикл
	else
		console.error(
			"[TELEGRAM] токен не вшит в сборку — remote control отключён",
		);
}

// ---- Сетка безопасности -----------------------------------------------------
// Headless-демон: без окон и трея упавший процесс просто исчезает — Telegram
// замолкает, keep-awake снимается, никто не узнаёт, что случилось.
//
// unhandledRejection: логируем и best-effort шлём в Telegram, но НЕ выходим —
// это неблокирующие сетевые/async ошибки, процесс в целом остаётся в рабочем
// состоянии, и это соответствует тому, как Node ведёт себя без единого
// listener'а на это событие (сам факт reject не роняет процесс).
//
// uncaughtException: здесь всё наоборот. Сам факт наличия listener'а на
// uncaughtException ОТМЕНЯЕТ дефолтное аварийное завершение Node — если
// после логирования просто вернуться, процесс продолжит жить. А у
// headless-демона event loop никогда не опустеет сам собой
// (heartbeatTimer/durationTimer/powerSaveBlocker всегда что-то держат), так
// что без явного process.exit() процесс молча зависнет в неконсистентном
// состоянии — без UI, без супервизора (launchd KeepAlive не настроен),
// и без единого шанса перезапуститься. Поэтому: логируем, даём best-effort
// уведомлению в Telegram короткий шанс уйти (с собственным таймаутом, чтобы
// зависшая отправка не держала процесс вечно) и затем гарантированно выходим
// с ненулевым кодом.
process.on("unhandledRejection", (reason) => {
	const detail =
		reason instanceof Error ? reason.stack || reason.message : String(reason);
	console.error("[FATAL] Unhandled rejection:", detail);
	telegramNotify(
		"💥 Внутренняя ошибка (unhandled rejection) — смотри логи на Маке:\n" +
			detail,
	);
});

process.on("uncaughtException", (err) => {
	const detail = (err && (err.stack || err.message)) || String(err);
	console.error(
		"[FATAL] Uncaught exception — процесс сейчас завершится (exit 1):",
		detail,
	);

	let exited = false;
	const exitNow = () => {
		if (exited) return;
		exited = true;
		try {
			if (keepAwake) keepAwake.stop();
		} catch (e) {
			// best-effort — не даём снятию keep-awake задержать выход
		}
		process.exit(1);
	};

	// Гарантированный выход даже если отправка в Telegram зависнет.
	const timer = setTimeout(exitNow, 1500);
	if (timer.unref) timer.unref();

	Promise.resolve()
		.then(() =>
			telegramNotify(
				"💥 Критическая ошибка (uncaught exception) — приложение сейчас завершится, " +
					"перезапусти вручную на Маке:\n" +
					detail,
			),
		)
		.catch(() => {})
		.finally(exitNow);
});

// В дев-режиме (`npm start`, app.isPackaged === false) не трогаем macOS login
// items вообще — иначе каждый `npm start` прописывает голый бинарник Electron
// в объекты входа разработчика. ensureAutostart просто не вызывается; вызовы
// возвращают a no-op-подобный результат для UI-текста.
function safeEnsureAutostart(desired) {
	if (!app.isPackaged) {
		return { desired, actual: false, ok: true, reason: "dev" };
	}
	return ensureAutostart({ app, desired });
}

// ---- Keep-awake: сброс HID idle --------------------------------------------
// ---- Keep-awake: сброс HID idle через встроенный osascript (JXA) ----------
// `powerSaveBlocker` (см. keep-awake.js) не даёт экрану/системе уснуть, но НЕ
// сбрасывает HID idle time — время с последнего HID-события. Именно по нему
// macOS (и MDM-политики) решают, что пользователь «бездействует», и срабатывают
// «выйти/перезагрузить при бездействии». Сбросить HID idle можно только реальным
// HID-событием: двигаем курсор +1px / −1px через CGEvent из CoreGraphics.
//
// Никаких внешних бинарников: скрипт на JavaScript for Automation (JXA)
// выполняется встроенным `osascript`. Бридж CGPoint проверен — корректен.
//
// ВАЖНО: постинг синтетических CGEvent на современной macOS требует, чтобы у
// приложения было Accessibility (System Settings → Privacy & Security →
// Accessibility → добавить TS Activity Keeper). Это граница ОС — её не обойти
// кодом ни для какого механизма (cliclick/Swift/native — все упрутся в то же).
// Поэтому при старте гоняем self-test: реально ли двигается курсор, и если нет —
// прямо говорим (лог + Telegram) выдать Accessibility.
let jiggleAvailable = false;
let axNotified = false;

const JXA_NUDGE = `
ObjC.import('CoreGraphics');
var e = $.CGEventCreate(null);
var loc = $.CGEventGetLocation(e);
$.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, {x: loc.x + 1, y: loc.y}, 0));
$.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, loc, 0));
"ok";
`;

// Self-test: двигаем на +40px, читаем позицию обратно, возвращаем на место.
// «1» — курсор реально сдвинулся (Accessibility есть), «0» — пост отфильтрован.
const JXA_PROBE = `
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
function pos() { var e = $.CGEventCreate(null); return $.CGEventGetLocation(e); }
function sleep(ms) { $.NSThread.sleepForTimeInterval(ms / 1000); }
var a = pos();
$.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, {x: a.x + 40, y: a.y}, 0));
sleep(60);
var b = pos();
$.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, a, 0));
Math.abs(b.x - a.x) > 5 ? "1" : "0";
`;

function runJxa(script) {
	return new Promise((resolve, reject) => {
		const child = execFile("osascript", ["-l", "JavaScript"], (err, stdout) => {
			if (err) reject(err);
			else resolve(stdout.trim());
		});
		child.stdin.end(script);
	});
}

async function probeJiggle() {
	try {
		return (await runJxa(JXA_PROBE)) === "1";
	} catch {
		return false;
	}
}

function describeKeepAwake() {
	if (!keepAwake || !keepAwake.isActive()) return "неактивен";
	if (keepAwake.isNudging() && jiggleAvailable)
		return "активен (анти-сон + анти-idle)";
	if (keepAwake.isNudging())
		return "активен (анти-сон; анти-idle ждёт Accessibility)";
	return "активен (только анти-сон)";
}

// ---- Запуск ----------------------------------------------------------------

app.whenReady().then(async () => {
	if (app.dock) app.dock.hide();

	keepAwake = createKeepAwake({
		blocker: powerSaveBlocker,
		log: (msg) => console.error("[KEEP-AWAKE]", msg),
		nudge: () => runJxa(JXA_NUDGE),
	});
	keepAwake.start();

	// Периодически проверяем реальную работоспособность сброса HID idle: постинг
	// CGEvent требует Accessibility, а его выдают вручную (обычно ПОСЛЕ первого
	// запуска). Чтобы демон сам «ожил», как только доступ выдан, — перепроверяем
	// каждые 2 мин и обновляем статус (headless-режим, ручной рестарт не очевиден).
	function runProbe() {
		probeJiggle().then((ok) => {
			const was = jiggleAvailable;
			jiggleAvailable = ok;
			if (ok && !was) {
				axNotified = false; // AX мог «слететь» после ребилда — разрешить алерт снова
				console.log("[KEEP-AWAKE] JXA-тычок работает — HID idle сбрасывается.");
				telegramNotify(
					"✅ Защита от бездействия работает: HID idle сбрасывается.",
				);
			} else if (!ok && !axNotified) {
				axNotified = true;
				console.error(
					"[KEEP-AWAKE] JXA-тычок не двигает курсор — приложению не выдано Accessibility. HID idle НЕ сбрасывается: политика «перезагрузка по бездействию» может сработать. Выдай: System Settings → Privacy & Security → Accessibility → добавь TS Activity Keeper",
				);
				telegramNotify(
					"⚠️ Защита от «перезагрузки по бездействию» требует Accessibility.\n" +
						"System Settings → Privacy & Security → Accessibility → включи TS Activity Keeper.\n" +
						"Без этого мышь не двигается и HID idle не сбрасывается.",
				);
			}
		});
	}
	runProbe();
	const probeTimer = setInterval(runProbe, 120000);
	if (probeTimer.unref) probeTimer.unref();

	const settings = settingsStore.loadSettings();
	autostartResult = safeEnsureAutostart(settings.autostart);
	if (!autostartResult.ok) {
		console.error("[AUTOSTART]", describeAutostart(autostartResult));
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
	if (hasAccount) {
		setTimeout(() => {
			startBot().catch((e) =>
				console.error("[TRACKING] startBot failed:", e.message),
			);
		}, 2000);
	}
});

app.on("window-all-closed", (e) => {
	e.preventDefault();
});

app.on("before-quit", (e) => {
	if (telegramBot) telegramBot.stop();
	if (keepAwake) keepAwake.stop();
	if (isQuitting) return;
	if (running) {
		isQuitting = true;
		e.preventDefault();
		running = false;
		if (reminder) reminder.stop();
		clearTimeout(heartbeatTimer);
		stopPairingLoop();
		stopDurationTimer();
		Promise.race([
			backend.stop(),
			new Promise((resolve) => setTimeout(resolve, 5000)),
		]).finally(() => app.quit());
	}
});
