// Не даёт macOS уснуть и погасить экран, пока приложение запущено.
// `prevent-display-sleep` — единственный режим, который заодно не даёт
// сработать скринсейверу, блокировке экрана и авто-логауту по бездействию.
// powerSaveBlocker инжектится, чтобы модуль тестировался без Electron.

const KEEP_AWAKE_MODE = 'prevent-display-sleep';

function createKeepAwake({ blocker, mode = KEEP_AWAKE_MODE, log = () => {} }) {
    let id = null;

    function active() {
        return id != null && blocker.isStarted(id);
    }

    return {
        start() {
            if (active()) return true;
            try {
                id = blocker.start(mode);
                return true;
            } catch (e) {
                log('keep-awake не включился: ' + e.message);
                id = null;
                return false;
            }
        },
        stop() {
            if (id == null) return;
            try {
                if (blocker.isStarted(id)) blocker.stop(id);
            } catch (e) {
                log('keep-awake не выключился: ' + e.message);
            }
            id = null;
        },
        isActive: active,
    };
}

module.exports = { createKeepAwake, KEEP_AWAKE_MODE };
