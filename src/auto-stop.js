// Auto-stop deadline tracker: pure state, no timers. main.js arms it when
// tracking starts and polls `expired()` from its 1s duration tick, so there is
// no separate timer to keep in sync with start/stop/re-arm.
// `now` is injected (Date.now in production) for testability.

function createAutoStop(now) {
    let deadline = null; // epoch ms, or null when disarmed

    return {
        // durationMs <= 0 disarms (setting "0 minutes" = disabled).
        arm(durationMs) {
            deadline = durationMs > 0 ? now() + durationMs : null;
        },
        disarm() { deadline = null; },
        isArmed() { return deadline != null; },
        remainingMs() {
            return deadline == null ? null : Math.max(0, deadline - now());
        },
        expired() { return deadline != null && now() >= deadline; },
    };
}

module.exports = { createAutoStop };
