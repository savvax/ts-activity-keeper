// Desktop notifications for tracking interruptions.
// Electron Notification + timers are injected for testability.
// Settings are read through `getSettings` at every notification-fire time, so
// toggling the sound preference takes effect immediately — including for a
// reminder loop that is already running.

function createNotifier({ createNotification, setInterval, clearInterval, getSettings }) {
    let reminderTimer = null;
    let notifying = false;
    let currentMessage = '';

    function settings() {
        return (getSettings && getSettings()) || {};
    }

    function show(body) {
        const silent = !settings().notifySound;
        const n = createNotification({ title: 'TS Activity Keeper', body, silent });
        if (n && typeof n.show === 'function') n.show();
    }

    function clearReminder() {
        if (reminderTimer != null) {
            clearInterval(reminderTimer);
            reminderTimer = null;
        }
    }

    return {
        notCounting(message) {
            // Keep the message current: a re-entry (e.g. stalled -> disconnected)
            // updates what the running reminder shows.
            currentMessage = message;
            if (notifying) return; // already in not-counting; reminder already running
            notifying = true;
            show(currentMessage);
            const parsed = parseInt(settings().notifyReminderMinutes, 10);
            const minutes = Number.isFinite(parsed) ? Math.max(1, parsed) : 5;
            reminderTimer = setInterval(
                () => show('Time is still not being counted: ' + currentMessage),
                minutes * 60 * 1000
            );
        },
        restored() {
            if (!notifying) { clearReminder(); return; }
            notifying = false;
            clearReminder();
            show('Connection restored — time is being counted again.');
        },
        info(message) {
            // One-off notification (auto-stop fired, remote command, ...).
            show(message);
        },
        stop() {
            notifying = false;
            clearReminder();
        },
    };
}

module.exports = { createNotifier };
