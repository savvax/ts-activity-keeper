// Desktop notifications for tracking interruptions.
// Electron Notification + timers are injected for testability.

function createNotifier({ createNotification, setInterval, clearInterval }) {
    let reminderTimer = null;
    let notifying = false;
    let currentMessage = '';
    let currentSilent = false;

    function show(body, silent) {
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
        notCounting(message, settings) {
            // Keep message and sound symmetric: both reflect the latest call, so a
            // re-entry (e.g. stalled -> disconnected) updates what the reminder shows.
            currentMessage = message;
            currentSilent = !settings.notifySound;
            if (notifying) return; // already in not-counting; reminder already running
            notifying = true;
            show(currentMessage, currentSilent);
            const parsed = parseInt(settings.notifyReminderMinutes, 10);
            const minutes = Number.isFinite(parsed) ? Math.max(1, parsed) : 5;
            reminderTimer = setInterval(
                () => show('Time is still not being counted: ' + currentMessage, currentSilent),
                minutes * 60 * 1000
            );
        },
        restored(settings) {
            if (!notifying) { clearReminder(); return; }
            notifying = false;
            clearReminder();
            show('Connection restored — time is being counted again.', !settings.notifySound);
        },
        stop() {
            notifying = false;
            clearReminder();
        },
    };
}

module.exports = { createNotifier };
