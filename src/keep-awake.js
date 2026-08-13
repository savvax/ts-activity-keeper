// Не даёт macOS уснуть, погасить экран и — главное — не даёт системе решить,
// что пользователь «бездействует».
//
// Два независимых механизма:
//  1. powerSaveBlocker в режиме `prevent-display-sleep` держит power-assertion,
//     не давая экрану и системе уснуть. Но power-assertion НЕ сбрасывает HID
//     idle time — время с последнего реального HID-события (мышь/клавиатура).
//  2. Поэтому, если передан `nudge`, раз в `nudgeIntervalMs` вызывается он —
//     внешний тычок мышью (+1px / −1px), который порождает настоящее CGEvent-
//     событие и обнуляет HID idle. Именно по HID idle срабатывают политики
//     «выйти/перезагрузить при бездействии» (нативный Log out after inactivity,
//     MDM-профили, Teams/Slack «Away») — powerSaveBlocker их НЕ отменяет,
//     а nudge — отменяет.
//
// powerSaveBlocker, setInterval/clearInterval и сам nudge инжектятся, чтобы
// модуль тестировался без Electron, без реальных таймеров и без child_process.

const KEEP_AWAKE_MODE = "prevent-display-sleep";
const DEFAULT_NUDGE_INTERVAL_MS = 60_000;

function createKeepAwake({
	blocker,
	mode = KEEP_AWAKE_MODE,
	log = () => {},
	nudge = null,
	nudgeIntervalMs = DEFAULT_NUDGE_INTERVAL_MS,
	setIntervalFn = setInterval,
	clearIntervalFn = clearInterval,
}) {
	let id = null;
	let nudgeTimer = null;

	function active() {
		return id != null && blocker.isStarted(id);
	}

	function nudgeActive() {
		return typeof nudge === "function" && nudgeTimer != null;
	}

	function fireNudge() {
		Promise.resolve()
			.then(() => nudge())
			.catch((e) => log("keep-awake nudge не сработал: " + (e && e.message)));
	}

	function startNudge() {
		if (typeof nudge !== "function" || nudgeTimer != null) return;
		// Сразу один тычок, чтобы не ждать целый интервал до первого сброса.
		fireNudge();
		nudgeTimer = setIntervalFn(fireNudge, nudgeIntervalMs);
	}

	function stopNudge() {
		if (nudgeTimer == null) return;
		clearIntervalFn(nudgeTimer);
		nudgeTimer = null;
	}

	return {
		start() {
			if (active()) return true;
			try {
				id = blocker.start(mode);
				startNudge();
				return true;
			} catch (e) {
				log("keep-awake не включился: " + e.message);
				id = null;
				return false;
			}
		},
		stop() {
			if (id != null) {
				try {
					if (blocker.isStarted(id)) blocker.stop(id);
				} catch (e) {
					log("keep-awake не выключился: " + e.message);
				}
				id = null;
			}
			stopNudge();
		},
		isActive: active,
		isNudging: nudgeActive,
	};
}

module.exports = {
	createKeepAwake,
	KEEP_AWAKE_MODE,
	DEFAULT_NUDGE_INTERVAL_MS,
};
