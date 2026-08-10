// Повторные напоминания в Telegram, пока время не считается.
// Отправка и таймеры инжектятся — модуль не знает ни про Electron, ни про сеть.
// Интервал читается в момент падения, поэтому смена /remind применяется
// со следующего падения (а не задним числом ломает текущий цикл).

function createReminder({ send, setInterval, clearInterval, getIntervalMinutes }) {
    let timer = null;
    let notifying = false;
    let currentMessage = '';

    function clearReminder() {
        if (timer != null) {
            clearInterval(timer);
            timer = null;
        }
    }

    function intervalMs() {
        const parsed = parseInt(getIntervalMinutes && getIntervalMinutes(), 10);
        const minutes = Number.isFinite(parsed) ? Math.max(0, parsed) : 5;
        return minutes * 60 * 1000;
    }

    return {
        notCounting(message) {
            // Перезаход (stalled -> disconnected) обновляет текст работающего повтора.
            currentMessage = message;
            if (notifying) return;
            notifying = true;
            send('⚠️ Время НЕ считается: ' + currentMessage);
            const ms = intervalMs();
            if (!ms) return; // 0 = только одно сообщение
            timer = setInterval(
                () => send('⚠️ Время всё ещё не считается: ' + currentMessage),
                ms
            );
        },
        restored() {
            if (!notifying) { clearReminder(); return; }
            notifying = false;
            clearReminder();
            send('✅ Связь восстановлена — время снова считается.');
        },
        stop() {
            notifying = false;
            clearReminder();
        },
        isNotifying: () => notifying,
    };
}

module.exports = { createReminder };
