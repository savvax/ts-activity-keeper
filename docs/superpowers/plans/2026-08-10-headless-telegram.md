# Headless Telegram-only TS Activity Keeper — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Превратить menu-bar Electron-приложение в невидимый фоновый демон, управляемый исключительно через Telegram-бота с вшитым при сборке токеном, который дополнительно не даёт Mac уснуть и сам прописывается в автозапуск.

**Architecture:** Вся логика остаётся в маленьких Electron-free модулях в `src/` с юнит-тестами на `node --test`; `main.js` остаётся единственным местом с Electron API и только оркестрирует. UI-слой (renderer, tray, preload, notifier) удаляется целиком, его роль берёт `telegram-bot.js`. Токен и секрет-фраза попадают в `src/build-config.js`, который генерится prebuild-скриптом.

**Tech Stack:** Node 18+, Electron 35, electron-builder 26, axios, `node --test` (без внешнего раннера).

## Global Constraints

- Тесты запускаются командой `npm test` (`node --test`), никакого другого раннера не добавлять.
- Новые модули в `src/` не должны импортировать `electron` — зависимости инжектятся через аргументы фабрики. Исключение: `main.js`.
- Все тексты, которые видит пользователь в Telegram, — на русском языке.
- Файл `src/build-config.js` НИКОГДА не коммитится (добавляется в `.gitignore`).
- Версия приложения после всех задач: `0.0.4`.
- Ключ настроек `telegramToken` удаляется — единственный источник токена это сборка.
- Не менять `api-tracker.js`, `tracking-health.js`, `session-clock.js`, `auto-stop.js`, `config-store.js`, `credentials.js`, `endpoints.js`, `paths.js`, `utils.js` и их тесты.
- Коммитить после каждой задачи; `node_modules/` и `dist/` в этом репозитории версионируются — никогда не делать `git add -A`, всегда перечислять пути явно.
- Спека: `docs/superpowers/specs/2026-08-10-headless-telegram-design.md`.

---

## File Structure

**Создаются:**

| Файл | Ответственность |
|---|---|
| `src/commands.js` | чистый разбор команд Telegram и их аргументов |
| `src/reminder.js` | повторные напоминания «время не считается» в Telegram |
| `src/keep-awake.js` | идемпотентная обёртка над `powerSaveBlocker` |
| `src/launch-agent.js` | попытка включить автозапуск + проверка фактического результата |
| `src/build-config-loader.js` | чтение вшитых секретов с фолбэком на ENV |
| `src/build-config.example.js` | шаблон вшиваемых секретов |
| `build/prepare-secrets.js` | prebuild: интерактивно спрашивает токен и пишет `src/build-config.js` |
| `test/commands.test.js`, `test/reminder.test.js`, `test/keep-awake.test.js`, `test/launch-agent.test.js`, `test/build-config-loader.test.js` | тесты новых модулей |

**Модифицируются:** `src/settings.js`, `src/telegram-bot.js`, `src/main.js`, `test/settings.test.js`, `test/telegram-bot.test.js`, `package.json`, `.gitignore`, `README.md`, `CLAUDE.md`.

**Удаляются:** `src/renderer/` (весь каталог), `src/preload.js`, `src/tray-icon.js`, `src/notifier.js`, `test/tray-icon.test.js`, `test/notifier.test.js`.

---

## Task 1: Настройки под новый набор ключей

**Files:**
- Modify: `src/settings.js`
- Test: `test/settings.test.js`

**Interfaces:**
- Consumes: `readConfig`/`writeConfig` из `config-store.js`, `configPath` из `paths.js` (без изменений).
- Produces: `DEFAULTS = { hideLogin, autoStopMinutes, autoStopLogout, remindMinutes, autostart, telegramChatId }`, функции `withDefaults(cfg)`, `sanitize(patch)`, `loadSettings()`, `saveSettings(patch)`.

- [ ] **Step 1: Переписать тест под новый набор ключей**

Полностью заменить содержимое `test/settings.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { DEFAULTS, withDefaults, sanitize } = require('../src/settings');

test('DEFAULTS содержит только актуальные ключи', () => {
  assert.deepStrictEqual(Object.keys(DEFAULTS).sort(), [
    'autoStopLogout', 'autoStopMinutes', 'autostart', 'hideLogin',
    'remindMinutes', 'telegramChatId',
  ]);
  assert.strictEqual(DEFAULTS.remindMinutes, 5);
  assert.strictEqual(DEFAULTS.autostart, true);
});

test('withDefaults подставляет умолчания и сохраняет заданные значения', () => {
  const out = withDefaults({ remindMinutes: 15 });
  assert.strictEqual(out.remindMinutes, 15);
  assert.strictEqual(out.autoStopMinutes, 0);
  assert.strictEqual(out.telegramChatId, '');
});

test('withDefaults игнорирует удалённые ключи', () => {
  const out = withDefaults({ notifySound: false, telegramToken: 'x' });
  assert.strictEqual(out.notifySound, undefined);
  assert.strictEqual(out.telegramToken, undefined);
});

test('sanitize возвращает только переданные ключи', () => {
  assert.deepStrictEqual(sanitize({ autostart: false }), { autostart: false });
  assert.deepStrictEqual(sanitize({}), {});
});

test('sanitize: remindMinutes — неотрицательное целое, 0 разрешён', () => {
  assert.strictEqual(sanitize({ remindMinutes: '15' }).remindMinutes, 15);
  assert.strictEqual(sanitize({ remindMinutes: 0 }).remindMinutes, 0);
  assert.strictEqual(sanitize({ remindMinutes: -3 }).remindMinutes, 0);
  assert.strictEqual(sanitize({ remindMinutes: 'abc' }).remindMinutes, 5);
});

test('sanitize: autoStopMinutes не бывает отрицательным', () => {
  assert.strictEqual(sanitize({ autoStopMinutes: '90' }).autoStopMinutes, 90);
  assert.strictEqual(sanitize({ autoStopMinutes: -5 }).autoStopMinutes, 0);
});

test('sanitize: hideLogin односторонний — false отбрасывается', () => {
  assert.deepStrictEqual(sanitize({ hideLogin: true }), { hideLogin: true });
  assert.deepStrictEqual(sanitize({ hideLogin: false }), {});
});

test('sanitize: autostart приводится к boolean', () => {
  assert.strictEqual(sanitize({ autostart: 'on' }).autostart, true);
  assert.strictEqual(sanitize({ autostart: false }).autostart, false);
});

test('sanitize: telegramChatId тримится, telegramToken больше не принимается', () => {
  assert.strictEqual(sanitize({ telegramChatId: ' 555 ' }).telegramChatId, '555');
  assert.strictEqual(sanitize({ telegramToken: 'abc' }).telegramToken, undefined);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test test/settings.test.js`
Expected: FAIL — `DEFAULTS` всё ещё содержит `notifySound`, `notifyReminderMinutes`, `telegramToken`.

- [ ] **Step 3: Обновить `src/settings.js`**

Заменить блок `DEFAULTS` и тело `sanitize`:

```js
const DEFAULTS = {
    hideLogin: false,
    autoStopMinutes: 0,      // 0 = автостоп выключен
    autoStopLogout: false,   // при срабатывании автостопа ещё и разлогинить
    remindMinutes: 5,        // повтор «время не считается»; 0 = без повторов
    autostart: true,         // прописывать себя в объекты входа
    telegramChatId: '',
};
```

```js
// Возвращает патч только из переданных и провалидированных ключей.
function sanitize(patch) {
    patch = patch || {};
    const out = {};
    // hideLogin односторонний: в патч попадает только `true`.
    if (patch.hideLogin === true) out.hideLogin = true;
    if (patch.autoStopMinutes != null) {
        const n = parseInt(patch.autoStopMinutes, 10);
        out.autoStopMinutes = Number.isFinite(n) ? Math.max(0, n) : DEFAULTS.autoStopMinutes;
    }
    if (patch.autoStopLogout != null) out.autoStopLogout = !!patch.autoStopLogout;
    if (patch.remindMinutes != null) {
        const n = parseInt(patch.remindMinutes, 10);
        out.remindMinutes = Number.isFinite(n) ? Math.max(0, n) : DEFAULTS.remindMinutes;
    }
    if (patch.autostart != null) out.autostart = !!patch.autostart;
    if (patch.telegramChatId != null) out.telegramChatId = String(patch.telegramChatId).trim();
    return out;
}
```

- [ ] **Step 4: Прогнать тест**

Run: `node --test test/settings.test.js`
Expected: PASS (9 тестов).

- [ ] **Step 5: Коммит**

```bash
git add src/settings.js test/settings.test.js
git commit -m "Rework settings keys for headless Telegram control"
```

---

## Task 2: Парсер команд

**Files:**
- Create: `src/commands.js`
- Test: `test/commands.test.js`

**Interfaces:**
- Consumes: ничего.
- Produces:
  - `parseCommand(text) -> { cmd: string, args: string[] } | null` — `cmd` в нижнем регистре с ведущим `/`, суффикс `@BotName` отрезан.
  - `parseLogin(args) -> { ok: true, email, password } | { ok: false, error }`
  - `parseAutostop(args) -> { ok: true, minutes: number, logout: boolean } | { ok: false, error }`
  - `parseRemind(args) -> { ok: true, minutes: number } | { ok: false, error }`
  - `parseToggle(args) -> { ok: true, on: boolean } | { ok: false, error }`

- [ ] **Step 1: Написать падающий тест**

Создать `test/commands.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseCommand, parseLogin, parseAutostop, parseRemind, parseToggle,
} = require('../src/commands');

test('parseCommand: имя команды нормализуется, аргументы отделяются', () => {
  assert.deepStrictEqual(parseCommand('/Status@MyBot'), { cmd: '/status', args: [] });
  assert.deepStrictEqual(parseCommand('  /autostop  90   logout '), {
    cmd: '/autostop', args: ['90', 'logout'],
  });
});

test('parseCommand: не-команды и мусор дают null', () => {
  assert.strictEqual(parseCommand('привет'), null);
  assert.strictEqual(parseCommand(''), null);
  assert.strictEqual(parseCommand(undefined), null);
  assert.strictEqual(parseCommand(42), null);
});

test('parseLogin: email и пароль', () => {
  assert.deepStrictEqual(parseLogin(['a@b.c', 'secret']), {
    ok: true, email: 'a@b.c', password: 'secret',
  });
});

test('parseLogin: пароль с пробелами склеивается', () => {
  const r = parseLogin(['a@b.c', 'two', 'words']);
  assert.strictEqual(r.password, 'two words');
});

test('parseLogin: мало аргументов или не email', () => {
  assert.strictEqual(parseLogin(['a@b.c']).ok, false);
  assert.strictEqual(parseLogin([]).ok, false);
  const r = parseLogin(['notanemail', 'pw']);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /email/i);
});

test('parseAutostop: минуты и флаг logout', () => {
  assert.deepStrictEqual(parseAutostop(['90']), { ok: true, minutes: 90, logout: false });
  assert.deepStrictEqual(parseAutostop(['90', 'logout']), { ok: true, minutes: 90, logout: true });
});

test('parseAutostop: off и 0 выключают', () => {
  assert.deepStrictEqual(parseAutostop(['off']), { ok: true, minutes: 0, logout: false });
  assert.deepStrictEqual(parseAutostop(['0']), { ok: true, minutes: 0, logout: false });
});

test('parseAutostop: мусор и пустой ввод отклоняются', () => {
  assert.strictEqual(parseAutostop([]).ok, false);
  assert.strictEqual(parseAutostop(['abc']).ok, false);
  assert.strictEqual(parseAutostop(['-5']).ok, false);
});

test('parseRemind: минуты, off и мусор', () => {
  assert.deepStrictEqual(parseRemind(['15']), { ok: true, minutes: 15 });
  assert.deepStrictEqual(parseRemind(['off']), { ok: true, minutes: 0 });
  assert.deepStrictEqual(parseRemind(['0']), { ok: true, minutes: 0 });
  assert.strictEqual(parseRemind(['abc']).ok, false);
  assert.strictEqual(parseRemind([]).ok, false);
});

test('parseToggle: on/off регистронезависимо, остальное отклоняется', () => {
  assert.deepStrictEqual(parseToggle(['ON']), { ok: true, on: true });
  assert.deepStrictEqual(parseToggle(['off']), { ok: true, on: false });
  assert.strictEqual(parseToggle([]).ok, false);
  assert.strictEqual(parseToggle(['maybe']).ok, false);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test test/commands.test.js`
Expected: FAIL — `Cannot find module '../src/commands'`.

- [ ] **Step 3: Реализовать `src/commands.js`**

```js
// Чистый разбор Telegram-команд и их аргументов. Никаких сетевых и
// Electron-зависимостей — только строки, чтобы всё покрывалось юнит-тестами.

// '/Autostop@MyBot 90 logout' -> { cmd: '/autostop', args: ['90', 'logout'] }
function parseCommand(text) {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return null;
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].split('@')[0].toLowerCase();
    return { cmd, args: parts.slice(1) };
}

function parseLogin(args) {
    if (!args || args.length < 2) {
        return { ok: false, error: 'Формат: /login <email> <пароль>' };
    }
    const email = args[0];
    // Пароль может содержать пробелы — забираем весь остаток строки.
    const password = args.slice(1).join(' ');
    if (!email.includes('@')) {
        return { ok: false, error: 'Первым аргументом ожидается email. Формат: /login <email> <пароль>' };
    }
    return { ok: true, email, password };
}

function parseAutostop(args) {
    const usage = 'Формат: /autostop <минуты> [logout] или /autostop off';
    if (!args || !args.length) return { ok: false, error: usage };
    const first = args[0].toLowerCase();
    if (first === 'off' || first === '0') return { ok: true, minutes: 0, logout: false };
    const minutes = parseInt(first, 10);
    if (!Number.isFinite(minutes) || minutes <= 0) return { ok: false, error: usage };
    const logout = args.slice(1).some((a) => a.toLowerCase() === 'logout');
    return { ok: true, minutes, logout };
}

function parseRemind(args) {
    const usage = 'Формат: /remind <минуты> или /remind off';
    if (!args || !args.length) return { ok: false, error: usage };
    const first = args[0].toLowerCase();
    if (first === 'off' || first === '0') return { ok: true, minutes: 0 };
    const minutes = parseInt(first, 10);
    if (!Number.isFinite(minutes) || minutes <= 0) return { ok: false, error: usage };
    return { ok: true, minutes };
}

function parseToggle(args) {
    const value = ((args && args[0]) || '').toLowerCase();
    if (value === 'on') return { ok: true, on: true };
    if (value === 'off') return { ok: true, on: false };
    return { ok: false, error: 'Формат: on или off' };
}

module.exports = { parseCommand, parseLogin, parseAutostop, parseRemind, parseToggle };
```

- [ ] **Step 4: Прогнать тест**

Run: `node --test test/commands.test.js`
Expected: PASS (10 тестов).

- [ ] **Step 5: Коммит**

```bash
git add src/commands.js test/commands.test.js
git commit -m "Add pure Telegram command parser"
```

---

## Task 3: Напоминания в Telegram вместо macOS-уведомлений

**Files:**
- Create: `src/reminder.js`
- Test: `test/reminder.test.js`
- Delete: `src/notifier.js`, `test/notifier.test.js`

**Interfaces:**
- Consumes: ничего (всё инжектится).
- Produces: `createReminder({ send, setInterval, clearInterval, getIntervalMinutes })` → объект с методами `notCounting(message)`, `restored()`, `stop()`, `isNotifying()`.
  - `send(text: string)` — отправка в Telegram, вызывается синхронно.
  - `getIntervalMinutes()` — число минут между повторами, `0` = без повторов; читается в момент срабатывания `notCounting`.

- [ ] **Step 1: Написать падающий тест**

Создать `test/reminder.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createReminder } = require('../src/reminder');

// Управляемые таймеры: сохраняем колбэки и дёргаем их вручную.
function harness(minutes = 5) {
  const sent = [];
  const timers = new Map();
  let nextId = 1;
  let interval = minutes;
  const reminder = createReminder({
    send: (text) => sent.push(text),
    setInterval: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { timers.delete(id); },
    getIntervalMinutes: () => interval,
  });
  return {
    reminder, sent, timers,
    setInterval_: (m) => { interval = m; },
    tick: () => { for (const t of timers.values()) t.fn(); },
  };
}

test('notCounting шлёт сообщение сразу и заводит повтор', () => {
  const h = harness(5);
  h.reminder.notCounting('нет связи с сервером');
  assert.strictEqual(h.sent.length, 1);
  assert.match(h.sent[0], /нет связи с сервером/);
  assert.strictEqual(h.timers.size, 1);
  assert.strictEqual([...h.timers.values()][0].ms, 5 * 60 * 1000);
});

test('повторы уходят по тику таймера', () => {
  const h = harness(5);
  h.reminder.notCounting('нет связи с сервером');
  h.tick();
  h.tick();
  assert.strictEqual(h.sent.length, 3);
  assert.match(h.sent[2], /всё ещё/i);
});

test('повторный notCounting не дублирует сообщение, но обновляет текст', () => {
  const h = harness(5);
  h.reminder.notCounting('первая причина');
  h.reminder.notCounting('вторая причина');
  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.timers.size, 1);
  h.tick();
  assert.match(h.sent[1], /вторая причина/);
});

test('remindMinutes = 0 — одно сообщение без повторов', () => {
  const h = harness(0);
  h.reminder.notCounting('нет связи');
  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.timers.size, 0);
});

test('restored шлёт сообщение и гасит таймер только если было падение', () => {
  const h = harness(5);
  h.reminder.restored();
  assert.strictEqual(h.sent.length, 0);

  h.reminder.notCounting('нет связи');
  h.reminder.restored();
  assert.strictEqual(h.sent.length, 2);
  assert.match(h.sent[1], /восстановлена|снова считается/i);
  assert.strictEqual(h.timers.size, 0);
  assert.strictEqual(h.reminder.isNotifying(), false);
});

test('stop гасит таймер молча', () => {
  const h = harness(5);
  h.reminder.notCounting('нет связи');
  h.reminder.stop();
  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.timers.size, 0);
  assert.strictEqual(h.reminder.isNotifying(), false);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test test/reminder.test.js`
Expected: FAIL — `Cannot find module '../src/reminder'`.

- [ ] **Step 3: Реализовать `src/reminder.js`**

```js
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
```

- [ ] **Step 4: Прогнать тест**

Run: `node --test test/reminder.test.js`
Expected: PASS (6 тестов).

- [ ] **Step 5: Удалить старый notifier**

```bash
git rm src/notifier.js test/notifier.test.js
```

Примечание: `main.js` ещё импортирует `./notifier` — он будет переписан в Task 8, до тех пор `npm start` не работает. Юнит-тесты от этого не страдают, `main.js` ими не покрыт.

- [ ] **Step 6: Прогнать весь набор тестов**

Run: `npm test`
Expected: PASS — тестов `notifier`/`tray-icon` больше нет в наборе (`tray-icon.test.js` удалится в Task 8; сейчас он ещё зелёный).

- [ ] **Step 7: Коммит**

```bash
git add src/reminder.js test/reminder.test.js
git commit -m "Replace desktop notifier with Telegram reminder module"
```

---

## Task 4: Keep-awake

**Files:**
- Create: `src/keep-awake.js`
- Test: `test/keep-awake.test.js`

**Interfaces:**
- Consumes: ничего (blocker инжектится).
- Produces: `createKeepAwake({ blocker, mode, log })` → `{ start(), stop(), isActive() }`.
  - `blocker` — объект с `start(mode) -> id`, `stop(id)`, `isStarted(id) -> boolean` (в проде это `powerSaveBlocker` из Electron).
  - `mode` по умолчанию `'prevent-display-sleep'`.
  - `start()` возвращает `true` при успехе и `false`, если блокировщик кинул исключение.
- Также экспортируется `KEEP_AWAKE_MODE = 'prevent-display-sleep'`.

- [ ] **Step 1: Написать падающий тест**

Создать `test/keep-awake.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createKeepAwake, KEEP_AWAKE_MODE } = require('../src/keep-awake');

function fakeBlocker(opts = {}) {
  const started = new Set();
  const modes = [];
  let nextId = 1;
  return {
    modes,
    started,
    start(mode) {
      if (opts.throwOnStart) throw new Error('no power management');
      modes.push(mode);
      const id = nextId++;
      started.add(id);
      return id;
    },
    stop(id) { started.delete(id); },
    isStarted(id) { return started.has(id); },
  };
}

test('start включает блокировку в режиме prevent-display-sleep', () => {
  const blocker = fakeBlocker();
  const ka = createKeepAwake({ blocker });
  assert.strictEqual(ka.start(), true);
  assert.deepStrictEqual(blocker.modes, [KEEP_AWAKE_MODE]);
  assert.strictEqual(KEEP_AWAKE_MODE, 'prevent-display-sleep');
  assert.strictEqual(ka.isActive(), true);
});

test('повторный start идемпотентен — второй блокировщик не заводится', () => {
  const blocker = fakeBlocker();
  const ka = createKeepAwake({ blocker });
  ka.start();
  ka.start();
  ka.start();
  assert.strictEqual(blocker.modes.length, 1);
  assert.strictEqual(blocker.started.size, 1);
});

test('stop снимает блокировку и повторный stop безопасен', () => {
  const blocker = fakeBlocker();
  const ka = createKeepAwake({ blocker });
  ka.start();
  ka.stop();
  assert.strictEqual(blocker.started.size, 0);
  assert.strictEqual(ka.isActive(), false);
  ka.stop();
  assert.strictEqual(ka.isActive(), false);
});

test('после stop можно снова start', () => {
  const blocker = fakeBlocker();
  const ka = createKeepAwake({ blocker });
  ka.start();
  ka.stop();
  ka.start();
  assert.strictEqual(blocker.modes.length, 2);
  assert.strictEqual(ka.isActive(), true);
});

test('исключение блокировщика не роняет приложение', () => {
  const logged = [];
  const ka = createKeepAwake({
    blocker: fakeBlocker({ throwOnStart: true }),
    log: (m) => logged.push(m),
  });
  assert.strictEqual(ka.start(), false);
  assert.strictEqual(ka.isActive(), false);
  assert.strictEqual(logged.length, 1);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test test/keep-awake.test.js`
Expected: FAIL — `Cannot find module '../src/keep-awake'`.

- [ ] **Step 3: Реализовать `src/keep-awake.js`**

```js
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
```

- [ ] **Step 4: Прогнать тест**

Run: `node --test test/keep-awake.test.js`
Expected: PASS (5 тестов).

- [ ] **Step 5: Коммит**

```bash
git add src/keep-awake.js test/keep-awake.test.js
git commit -m "Add keep-awake power blocker wrapper"
```

---

## Task 5: Автозапуск с проверкой результата

**Files:**
- Create: `src/launch-agent.js`
- Test: `test/launch-agent.test.js`

**Interfaces:**
- Consumes: ничего (`app` инжектится).
- Produces:
  - `ensureAutostart({ app, desired, packaged }) -> { desired: boolean, actual: boolean, ok: boolean, reason: string }`, где `reason ∈ { 'disabled', 'already', 'set', 'denied', 'location' }`. `app` — объект с `getLoginItemSettings()`, `setLoginItemSettings(opts)`, `getPath('exe')`, `isPackaged`. `packaged` перекрывает `app.isPackaged` (для тестов).
  - `describeAutostart(result) -> string` — человеческая строка для Telegram.
  - `isBadLocation(exePath) -> boolean`.

- [ ] **Step 1: Написать падающий тест**

Создать `test/launch-agent.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { ensureAutostart, describeAutostart, isBadLocation } = require('../src/launch-agent');

function fakeApp(opts = {}) {
  let openAtLogin = !!opts.openAtLogin;
  return {
    calls: [],
    isPackaged: opts.isPackaged !== false,
    getPath: () => opts.exePath || '/Applications/TS Activity Keeper.app/Contents/MacOS/TS Activity Keeper',
    getLoginItemSettings() { return { openAtLogin }; },
    setLoginItemSettings(o) {
      this.calls.push(o);
      if (opts.throwOnSet) throw new Error('not permitted');
      if (!opts.silentlyIgnores) openAtLogin = !!o.openAtLogin;
    },
  };
}

test('уже включён — ничего не трогаем', () => {
  const app = fakeApp({ openAtLogin: true });
  const r = ensureAutostart({ app, desired: true });
  assert.deepStrictEqual(r, { desired: true, actual: true, ok: true, reason: 'already' });
  assert.strictEqual(app.calls.length, 0);
});

test('успешное включение', () => {
  const app = fakeApp({ openAtLogin: false });
  const r = ensureAutostart({ app, desired: true });
  assert.deepStrictEqual(r, { desired: true, actual: true, ok: true, reason: 'set' });
  assert.deepStrictEqual(app.calls, [{ openAtLogin: true }]);
});

test('молчаливый отказ системы ловится перечитыванием настройки', () => {
  const app = fakeApp({ openAtLogin: false, silentlyIgnores: true });
  const r = ensureAutostart({ app, desired: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.actual, false);
  assert.strictEqual(r.reason, 'denied');
});

test('исключение при установке — reason denied, без throw наружу', () => {
  const app = fakeApp({ openAtLogin: false, throwOnSet: true });
  const r = ensureAutostart({ app, desired: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'denied');
});

test('App Translocation и запуск не из /Applications дают reason location', () => {
  const translocated = fakeApp({
    exePath: '/private/var/folders/x1/AppTranslocation/ABC/d/TS Activity Keeper.app/Contents/MacOS/TS Activity Keeper',
  });
  assert.strictEqual(ensureAutostart({ app: translocated, desired: true }).reason, 'location');
  assert.strictEqual(translocated.calls.length, 0);

  const downloads = fakeApp({ exePath: '/Users/me/Downloads/TS Activity Keeper.app/Contents/MacOS/x' });
  assert.strictEqual(ensureAutostart({ app: downloads, desired: true }).reason, 'location');
});

test('в дев-режиме (не packaged) расположение не проверяется', () => {
  const app = fakeApp({ exePath: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron' });
  const r = ensureAutostart({ app, desired: true, packaged: false });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, 'set');
});

test('desired=false выключает автозапуск', () => {
  const app = fakeApp({ openAtLogin: true });
  const r = ensureAutostart({ app, desired: false });
  assert.deepStrictEqual(app.calls, [{ openAtLogin: false }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, 'disabled');
  assert.strictEqual(r.actual, false);
});

test('isBadLocation', () => {
  assert.strictEqual(isBadLocation('/Applications/X.app/Contents/MacOS/X'), false);
  assert.strictEqual(isBadLocation('/private/var/folders/q/X.app/Contents/MacOS/X'), true);
  assert.strictEqual(isBadLocation('/Users/me/Desktop/X.app/Contents/MacOS/X'), true);
  assert.strictEqual(isBadLocation(''), false);
});

test('describeAutostart даёт понятный текст на каждую причину', () => {
  assert.match(describeAutostart({ desired: true, ok: true, reason: 'set' }), /включ/i);
  assert.match(describeAutostart({ desired: false, ok: true, reason: 'disabled' }), /выкл/i);
  assert.match(describeAutostart({ desired: true, ok: false, reason: 'location' }), /Applications/);
  assert.match(describeAutostart({ desired: true, ok: false, reason: 'denied' }), /Объекты входа/);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test test/launch-agent.test.js`
Expected: FAIL — `Cannot find module '../src/launch-agent'`.

- [ ] **Step 3: Реализовать `src/launch-agent.js`**

```js
// Попытка прописать приложение в объекты входа macOS.
// setLoginItemSettings ничего не возвращает и может молча не сработать,
// поэтому результат всегда проверяется повторным чтением настройки.
// `app` инжектится, чтобы модуль тестировался без Electron.

// Пути, из которых автозапуск бесполезен: App Translocation монтирует .app
// во временный каталог, а запуск из ~/Downloads регистрирует путь, который
// пользователь почти наверняка сломает переносом.
const TRANSLOCATION_MARKERS = ['/private/var/folders/', '/AppTranslocation/'];

function isBadLocation(exePath) {
    if (!exePath) return false;
    if (TRANSLOCATION_MARKERS.some((marker) => exePath.includes(marker))) return true;
    return !exePath.startsWith('/Applications/');
}

function readOpenAtLogin(app) {
    try {
        return !!app.getLoginItemSettings().openAtLogin;
    } catch (e) {
        return false;
    }
}

function ensureAutostart({ app, desired, packaged }) {
    if (!desired) {
        try {
            app.setLoginItemSettings({ openAtLogin: false });
        } catch (e) {
            // выключение не критично — сообщать не о чем
        }
        return { desired: false, actual: readOpenAtLogin(app), ok: true, reason: 'disabled' };
    }

    const isPackaged = packaged != null ? packaged : !!app.isPackaged;
    if (isPackaged && isBadLocation(app.getPath('exe'))) {
        return { desired: true, actual: readOpenAtLogin(app), ok: false, reason: 'location' };
    }

    if (readOpenAtLogin(app)) {
        return { desired: true, actual: true, ok: true, reason: 'already' };
    }

    try {
        app.setLoginItemSettings({ openAtLogin: true });
    } catch (e) {
        return { desired: true, actual: false, ok: false, reason: 'denied' };
    }

    const actual = readOpenAtLogin(app);
    return { desired: true, actual, ok: actual, reason: actual ? 'set' : 'denied' };
}

function describeAutostart(result) {
    if (!result) return 'неизвестно';
    if (result.desired === false) return 'выкл';
    if (result.ok) return 'включён';
    if (result.reason === 'location') {
        return 'не удалось включить — приложение запущено не из /Applications; '
            + 'перетащи его в /Applications и запусти оттуда';
    }
    return 'не удалось включить — система не дала прописать автозапуск; '
        + 'разреши приложение в Системных настройках → Основные → Объекты входа';
}

module.exports = { ensureAutostart, describeAutostart, isBadLocation };
```

- [ ] **Step 4: Прогнать тест**

Run: `node --test test/launch-agent.test.js`
Expected: PASS (9 тестов).

- [ ] **Step 5: Коммит**

```bash
git add src/launch-agent.js test/launch-agent.test.js
git commit -m "Add login-item autostart with verified outcome"
```

---

## Task 6: Вшивание токена при сборке

**Files:**
- Create: `src/build-config-loader.js`, `src/build-config.example.js`, `build/prepare-secrets.js`
- Test: `test/build-config-loader.test.js`
- Modify: `package.json`, `.gitignore`

**Interfaces:**
- Consumes: ничего.
- Produces:
  - `loadBuildSecrets({ requireFn, env }) -> { token: string, secret: string }` — сначала вшитый `./build-config`, потом ENV (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_SECRET`); отсутствие файла не ошибка.
  - `src/build-config.js` (генерится) экспортирует `{ TELEGRAM_BOT_TOKEN, PAIRING_SECRET }`.

- [ ] **Step 1: Написать падающий тест**

Создать `test/build-config-loader.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { loadBuildSecrets } = require('../src/build-config-loader');

test('берёт вшитые значения из build-config', () => {
  const out = loadBuildSecrets({
    requireFn: () => ({ TELEGRAM_BOT_TOKEN: '111:aaa', PAIRING_SECRET: 'hunter2' }),
    env: {},
  });
  assert.deepStrictEqual(out, { token: '111:aaa', secret: 'hunter2' });
});

test('вшитые значения приоритетнее ENV', () => {
  const out = loadBuildSecrets({
    requireFn: () => ({ TELEGRAM_BOT_TOKEN: '111:aaa', PAIRING_SECRET: 'baked' }),
    env: { TELEGRAM_BOT_TOKEN: '222:bbb', TELEGRAM_SECRET: 'env' },
  });
  assert.deepStrictEqual(out, { token: '111:aaa', secret: 'baked' });
});

test('без build-config подхватывает ENV', () => {
  const out = loadBuildSecrets({
    requireFn: () => { throw new Error("Cannot find module './build-config'"); },
    env: { TELEGRAM_BOT_TOKEN: ' 222:bbb ', TELEGRAM_SECRET: ' env ' },
  });
  assert.deepStrictEqual(out, { token: '222:bbb', secret: 'env' });
});

test('нет ни файла, ни ENV — пустые строки, без исключения', () => {
  const out = loadBuildSecrets({
    requireFn: () => { throw new Error('missing'); },
    env: {},
  });
  assert.deepStrictEqual(out, { token: '', secret: '' });
});

test('пустой вшитый токен не перекрывает ENV', () => {
  const out = loadBuildSecrets({
    requireFn: () => ({ TELEGRAM_BOT_TOKEN: '', PAIRING_SECRET: '' }),
    env: { TELEGRAM_BOT_TOKEN: '222:bbb', TELEGRAM_SECRET: 'env' },
  });
  assert.deepStrictEqual(out, { token: '222:bbb', secret: 'env' });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test test/build-config-loader.test.js`
Expected: FAIL — `Cannot find module '../src/build-config-loader'`.

- [ ] **Step 3: Реализовать `src/build-config-loader.js`**

```js
// Читает секреты, вшитые при сборке в src/build-config.js.
// Файл в .gitignore и в dev-окружении отсутствует — тогда значения берутся
// из ENV (.env подхватывается dotenv в main.js), а их отсутствие не ошибка:
// приложение просто работает как трекер без remote control.

function loadBuildSecrets({ requireFn, env } = {}) {
    const load = requireFn || ((id) => require(id));
    let baked = {};
    try {
        baked = load('./build-config') || {};
    } catch (e) {
        baked = {};
    }
    const environment = env || process.env;
    const pick = (a, b) => String(a || b || '').trim();
    return {
        token: pick(baked.TELEGRAM_BOT_TOKEN, environment.TELEGRAM_BOT_TOKEN),
        secret: pick(baked.PAIRING_SECRET, environment.TELEGRAM_SECRET),
    };
}

module.exports = { loadBuildSecrets };
```

- [ ] **Step 4: Прогнать тест**

Run: `node --test test/build-config-loader.test.js`
Expected: PASS (5 тестов).

- [ ] **Step 5: Создать шаблон `src/build-config.example.js`**

```js
// Шаблон вшиваемых при сборке секретов.
// Реальный src/build-config.js генерится скриптом build/prepare-secrets.js
// на `npm run build` и НЕ коммитится (см. .gitignore).
module.exports = {
    TELEGRAM_BOT_TOKEN: '',  // токен от @BotFather
    PAIRING_SECRET: '',      // ключ для /start <секрет>
};
```

- [ ] **Step 6: Создать `build/prepare-secrets.js`**

```js
#!/usr/bin/env node
// prebuild-хук: гарантирует, что src/build-config.js существует и содержит
// токен бота. Приоритет: ENV (для CI) -> уже существующий файл -> интерактивный
// вопрос в терминале. Без токена сборка прерывается — собранное приложение
// без него неуправляемо.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const TARGET = path.join(__dirname, '..', 'src', 'build-config.js');

function write(token, secret) {
    const body = `// Сгенерировано build/prepare-secrets.js — не коммитить.\n`
        + `module.exports = {\n`
        + `    TELEGRAM_BOT_TOKEN: ${JSON.stringify(token)},\n`
        + `    PAIRING_SECRET: ${JSON.stringify(secret)},\n`
        + `};\n`;
    fs.writeFileSync(TARGET, body, { mode: 0o600 });
}

function mask(token) {
    if (token.length <= 8) return '***';
    return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function readExisting() {
    try {
        delete require.cache[require.resolve(TARGET)];
        const cfg = require(TARGET);
        return {
            token: String(cfg.TELEGRAM_BOT_TOKEN || '').trim(),
            secret: String(cfg.PAIRING_SECRET || '').trim(),
        };
    } catch (e) {
        return { token: '', secret: '' };
    }
}

function ask(rl, question) {
    return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

async function main() {
    const envToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const envSecret = String(process.env.TELEGRAM_SECRET || '').trim();

    if (envToken) {
        const secret = envSecret || crypto.randomBytes(8).toString('hex');
        write(envToken, secret);
        console.log(`[secrets] токен из ENV: ${mask(envToken)}`);
        console.log(`[secrets] ключ привязки: ${secret}`);
        return;
    }

    const existing = readExisting();
    if (existing.token) {
        console.log(`[secrets] использую src/build-config.js: ${mask(existing.token)}`);
        console.log(`[secrets] ключ привязки: ${existing.secret}`);
        return;
    }

    if (!process.stdin.isTTY) {
        console.error('[secrets] нет токена: задай TELEGRAM_BOT_TOKEN или запусти сборку в терминале');
        process.exit(1);
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const token = await ask(rl, 'Telegram bot token (от @BotFather): ');
        if (!token) {
            console.error('[secrets] токен обязателен — сборка прервана');
            process.exit(1);
        }
        const answered = await ask(rl, 'Ключ привязки для /start (Enter — сгенерировать): ');
        const secret = answered || crypto.randomBytes(8).toString('hex');
        write(token, secret);
        console.log(`[secrets] записан src/build-config.js: ${mask(token)}`);
        console.log(`[secrets] ключ привязки: ${secret}  ← им активируется бот: /start ${secret}`);
    } finally {
        rl.close();
    }
}

main().catch((e) => {
    console.error('[secrets] ошибка:', e.message);
    process.exit(1);
});
```

- [ ] **Step 7: Обновить `package.json`**

Поднять версию и добавить `prebuild` (секция `files` уже содержит `src/**/*`,
поэтому сгенерированный `src/build-config.js` попадёт в бандл сам):

```json
  "version": "0.0.4",
  "scripts": {
    "start": "electron .",
    "dev": "electron . --enable-logging",
    "prebuild": "node build/prepare-secrets.js",
    "build": "electron-builder",
    "test": "node --test"
  },
```

В секции `build.mac` добавить `extendInfo`:

```json
    "mac": {
      "category": "public.app-category.utilities",
      "icon": "icon.icns",
      "darkModeSupport": true,
      "extendInfo": {
        "LSUIElement": true
      },
      "target": [
        "dmg"
      ]
    },
```

- [ ] **Step 8: Обновить `.gitignore`**

Добавить строку (файл сейчас содержит только `.DS_Store` и себя):

```
src/build-config.js
```

- [ ] **Step 9: Проверить генерацию секретов**

Run: `TELEGRAM_BOT_TOKEN=123:test TELEGRAM_SECRET=hunter2 node build/prepare-secrets.js && node -e "const c=require('./src/build-config');console.log(c.TELEGRAM_BOT_TOKEN,c.PAIRING_SECRET)"`
Expected: печатает `123:test hunter2`; `git status --short src/build-config.js` не показывает файл (он в .gitignore).

- [ ] **Step 10: Прогнать весь набор тестов**

Run: `npm test`
Expected: PASS.

- [ ] **Step 11: Коммит**

```bash
git add src/build-config-loader.js src/build-config.example.js test/build-config-loader.test.js build/prepare-secrets.js package.json .gitignore
git commit -m "Bake Telegram bot token into the build; run app as LSUIElement"
```

---

## Task 7: Telegram-бот — привязка по ключу и новые команды

**Files:**
- Modify: `src/telegram-bot.js`
- Test: `test/telegram-bot.test.js`

**Interfaces:**
- Consumes: `parseCommand`, `parseLogin`, `parseAutostop`, `parseRemind`, `parseToggle` из `src/commands.js`.
- Produces: `createTelegramBot(opts)` → `{ start, stop, pollOnce, notify, isRunning, HELP }`.
  - `opts`: `request`, `getToken()`, `getSecret()`, `getChatId()`, `bindChatId(id)`, `handlers`, `apiBase?`, `wait?`, `log?`.
  - `handlers` — все асинхронные, каждый **возвращает строку-ответ**, которую бот отправляет в чат:
    `status()`, `login(email, password)`, `logout()`, `pause()`, `resume()`,
    `autostop(minutes, logout)`, `autostart(on)`, `remind(minutes)`, `hidelogin()`, `quit()`.
    Для `quit()` бот отправляет предупреждение ДО вызова хендлера и игнорирует его возвращаемое значение.

- [ ] **Step 1: Переписать тест**

Полностью заменить содержимое `test/telegram-bot.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createTelegramBot } = require('../src/telegram-bot');

// Фейковый Telegram API: очередь ответов getUpdates + перехват sendMessage.
function harness(opts = {}) {
  const updatesQueue = opts.updates || [];
  const sent = [];
  const calls = [];
  let chatId = opts.chatId || '';
  const token = opts.token != null ? opts.token : '123:abc';
  const secret = opts.secret != null ? opts.secret : 'hunter2';
  const handlers = {
    status: async () => 'STATUS TEXT',
    login: async (email, password) => { calls.push(`login:${email}:${password}`); return 'logged in'; },
    logout: async () => { calls.push('logout'); return 'logged out'; },
    pause: async () => { calls.push('pause'); return 'paused'; },
    resume: async () => { calls.push('resume'); return 'resumed'; },
    autostop: async (minutes, logout) => { calls.push(`autostop:${minutes}:${logout}`); return 'autostop set'; },
    autostart: async (on) => { calls.push(`autostart:${on}`); return 'autostart set'; },
    remind: async (minutes) => { calls.push(`remind:${minutes}`); return 'remind set'; },
    hidelogin: async () => { calls.push('hidelogin'); return 'masked'; },
    quit: async () => { calls.push('quit'); },
    ...opts.handlers,
  };
  const bot = createTelegramBot({
    request: async (cfg) => {
      if (cfg.url.endsWith('/sendMessage')) {
        sent.push(cfg.data);
        return { data: { ok: true } };
      }
      if (cfg.url.endsWith('/getUpdates')) {
        return { data: { ok: true, result: updatesQueue.shift() || [] } };
      }
      return { data: { ok: false } };
    },
    getToken: () => token,
    getSecret: () => secret,
    getChatId: () => chatId,
    bindChatId: (id) => { chatId = id; calls.push('bind:' + id); },
    handlers,
  });
  return { bot, sent, calls, getChatId: () => chatId };
}

const msg = (chatId, text, updateId = 1) =>
  ({ update_id: updateId, message: { chat: { id: chatId }, text } });

test('непривязанный чат: /start с верным ключом привязывает и шлёт help', async () => {
  const h = harness({ updates: [[msg(555, '/start hunter2')]] });
  await h.bot.pollOnce();
  assert.strictEqual(h.getChatId(), '555');
  assert.match(h.sent[0].text, /\/status/);
});

test('непривязанный чат: /start без ключа или с неверным — отказ без привязки', async () => {
  const h = harness({ updates: [[msg(555, '/start')], [msg(555, '/start wrong')]] });
  await h.bot.pollOnce();
  await h.bot.pollOnce();
  assert.strictEqual(h.getChatId(), '');
  assert.strictEqual(h.sent.length, 2);
  assert.match(h.sent[0].text, /ключ/i);
  assert.match(h.sent[1].text, /ключ/i);
});

test('непривязанный чат: прочие команды игнорируются молча', async () => {
  const h = harness({ updates: [[msg(555, '/status')]] });
  await h.bot.pollOnce();
  assert.strictEqual(h.sent.length, 0);
  assert.strictEqual(h.getChatId(), '');
});

test('пустой ключ в сборке не даёт привязать чат', async () => {
  const h = harness({ secret: '', updates: [[msg(555, '/start')], [msg(555, '/start ')]] });
  await h.bot.pollOnce();
  await h.bot.pollOnce();
  assert.strictEqual(h.getChatId(), '');
});

test('привязанный чат: чужие чаты игнорируются молча', async () => {
  const h = harness({ chatId: '555', updates: [[msg(666, '/quit'), msg(666, '/start hunter2')]] });
  await h.bot.pollOnce();
  assert.strictEqual(h.sent.length, 0);
  assert.deepStrictEqual(h.calls, []);
});

test('/status отвечает текстом хендлера', async () => {
  const h = harness({ chatId: '555', updates: [[msg(555, '/status')]] });
  await h.bot.pollOnce();
  assert.strictEqual(h.sent[0].text, 'STATUS TEXT');
  assert.strictEqual(h.sent[0].chat_id, '555');
});

test('/login передаёт email и пароль, отвечает текстом хендлера', async () => {
  const h = harness({ chatId: '555', updates: [[msg(555, '/login me@ts.ru p@ss word')]] });
  await h.bot.pollOnce();
  assert.deepStrictEqual(h.calls, ['login:me@ts.ru:p@ss word']);
  assert.strictEqual(h.sent[0].text, 'logged in');
});

test('/login с плохими аргументами не зовёт хендлер, а объясняет формат', async () => {
  const h = harness({ chatId: '555', updates: [[msg(555, '/login me@ts.ru')]] });
  await h.bot.pollOnce();
  assert.deepStrictEqual(h.calls, []);
  assert.match(h.sent[0].text, /Формат/);
});

test('/autostop разбирает минуты и logout', async () => {
  const h = harness({
    chatId: '555',
    updates: [[msg(555, '/autostop 90 logout', 1), msg(555, '/autostop off', 2), msg(555, '/autostop abc', 3)]],
  });
  await h.bot.pollOnce();
  assert.deepStrictEqual(h.calls, ['autostop:90:true', 'autostop:0:false']);
  assert.match(h.sent[2].text, /Формат/);
});

test('/autostart и /remind разбирают аргументы', async () => {
  const h = harness({
    chatId: '555',
    updates: [[msg(555, '/autostart on', 1), msg(555, '/remind off', 2), msg(555, '/autostart', 3)]],
  });
  await h.bot.pollOnce();
  assert.deepStrictEqual(h.calls, ['autostart:true', 'remind:0']);
  assert.match(h.sent[2].text, /Формат/);
});

test('/pause, /resume, /logout, /hidelogin дергают свои хендлеры', async () => {
  const h = harness({
    chatId: '555',
    updates: [[msg(555, '/pause', 1), msg(555, '/resume', 2), msg(555, '/logout', 3), msg(555, '/hidelogin', 4)]],
  });
  await h.bot.pollOnce();
  assert.deepStrictEqual(h.calls, ['pause', 'resume', 'logout', 'hidelogin']);
  assert.deepStrictEqual(h.sent.map((s) => s.text), ['paused', 'resumed', 'logged out', 'masked']);
});

test('/quit предупреждает до выхода', async () => {
  const order = [];
  const h = harness({
    chatId: '555',
    updates: [[msg(555, '/quit')]],
    handlers: { quit: async () => order.push('quit') },
  });
  await h.bot.pollOnce();
  assert.match(h.sent[0].text, /Мак/);
  assert.deepStrictEqual(order, ['quit']);
});

test('/revoke больше не существует', async () => {
  const h = harness({ chatId: '555', updates: [[msg(555, '/revoke')]] });
  await h.bot.pollOnce();
  assert.match(h.sent[0].text, /Неизвестная команда/);
});

test('команды регистронезависимы и терпят суффикс @BotName', async () => {
  const h = harness({ chatId: '555', updates: [[msg(555, '/STATUS@MyBot')]] });
  await h.bot.pollOnce();
  assert.strictEqual(h.sent[0].text, 'STATUS TEXT');
});

test('offset сдвигается за обработанные апдейты', async () => {
  const seen = [];
  const bot = createTelegramBot({
    request: async (cfg) => {
      if (cfg.url.endsWith('/getUpdates')) {
        seen.push(cfg.data.offset);
        return { data: { ok: true, result: seen.length === 1 ? [msg(555, '/help', 41)] : [] } };
      }
      return { data: { ok: true } };
    },
    getToken: () => 't',
    getSecret: () => 's',
    getChatId: () => '555',
    bindChatId: () => {},
    handlers: {},
  });
  await bot.pollOnce();
  await bot.pollOnce();
  assert.deepStrictEqual(seen, [0, 42]);
});

test('notify шлёт в привязанный чат и молчит без чата или токена', async () => {
  const h = harness({ chatId: '555' });
  await h.bot.notify('привет');
  assert.deepStrictEqual(h.sent[0], { chat_id: '555', text: 'привет' });

  const unbound = harness({ chatId: '' });
  await unbound.bot.notify('привет');
  assert.strictEqual(unbound.sent.length, 0);

  const tokenless = harness({ chatId: '555', token: '' });
  await tokenless.bot.notify('привет');
  assert.strictEqual(tokenless.sent.length, 0);
});

test('pollOnce возвращает false при отказе API', async () => {
  const bot = createTelegramBot({
    request: async () => ({ data: { ok: false } }),
    getToken: () => 't',
    getSecret: () => 's',
    getChatId: () => '',
    bindChatId: () => {},
    handlers: {},
  });
  assert.strictEqual(await bot.pollOnce(), false);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test test/telegram-bot.test.js`
Expected: FAIL — привязка всё ещё происходит по голому `/start`, команд с аргументами нет.

- [ ] **Step 3: Переписать `src/telegram-bot.js`**

Заменить шапку, `HELP`, `handleCommand` и `processUpdate` (остальное — `api`, `send`, `pollOnce`, `start`, `stop`, `notify` — не трогать, кроме отмеченного):

```js
// Telegram remote control: long-polls getUpdates и раздаёт команды в
// инжектированные хендлеры. Без Electron-зависимостей — `request` (axios в
// проде), доступ к токену/ключу/чату и хендлеры инжектятся, поэтому модуль
// тестируется фейками.
//
// Модель безопасности: бот отвечает ровно одному чату. Пока чат не привязан,
// принимается только `/start <ключ>` с ключом, вшитым в сборку; всё остальное
// от непривязанных чатов игнорируется молча. После привязки чужие чаты
// игнорируются молча.

const {
    parseCommand, parseLogin, parseAutostop, parseRemind, parseToggle,
} = require('./commands');

const TELEGRAM_API_BASE = 'https://api.telegram.org';

const HELP = [
    'TS Activity Keeper — управление:',
    '/status — статус, часы за сегодня и неделю',
    '/login <email> <пароль> — войти в аккаунт и запустить трекинг',
    '/logout — выйти из аккаунта (трекинг останавливается)',
    '/pause — остановить трекинг',
    '/resume — запустить трекинг',
    '/autostop <минуты> [logout] — таймер автостопа, /autostop off — выключить',
    '/autostart on|off — автозапуск при входе в macOS',
    '/remind <минуты>|off — как часто напоминать, что время не считается',
    '/hidelogin — маскировать логин в ответах (обратно не выключается)',
    '/quit — выйти из приложения на Маке',
    '/help — это сообщение',
].join('\n');
```

Тело `createTelegramBot`: добавить `getSecret` в деструктуризацию опций рядом с `getChatId`:

```js
    const getSecret = opts.getSecret || (() => '');
```

Заменить `handleCommand` целиком:

```js
    // Каждый хендлер возвращает текст ответа — бот сам его отправляет.
    async function handleCommand(parsed, chatId) {
        const { cmd, args } = parsed;
        switch (cmd) {
            case '/start':
            case '/help':
                return send(chatId, HELP);
            case '/status':
                return send(chatId, await handlers.status());
            case '/login': {
                const p = parseLogin(args);
                if (!p.ok) return send(chatId, p.error);
                return send(chatId, await handlers.login(p.email, p.password));
            }
            case '/logout':
                return send(chatId, await handlers.logout());
            case '/pause':
                return send(chatId, await handlers.pause());
            case '/resume':
                return send(chatId, await handlers.resume());
            case '/autostop': {
                const p = parseAutostop(args);
                if (!p.ok) return send(chatId, p.error);
                return send(chatId, await handlers.autostop(p.minutes, p.logout));
            }
            case '/autostart': {
                const p = parseToggle(args);
                if (!p.ok) return send(chatId, p.error);
                return send(chatId, await handlers.autostart(p.on));
            }
            case '/remind': {
                const p = parseRemind(args);
                if (!p.ok) return send(chatId, p.error);
                return send(chatId, await handlers.remind(p.minutes));
            }
            case '/hidelogin':
                return send(chatId, await handlers.hidelogin());
            case '/quit':
                // Предупреждаем, пока процесс ещё жив.
                await send(chatId, 'Выхожу из приложения. Запустить обратно можно только с Мака.');
                return handlers.quit();
            default:
                return send(chatId, 'Неизвестная команда. /help — список.');
        }
    }
```

Заменить `processUpdate` целиком:

```js
    async function processUpdate(update) {
        const msg = update && update.message;
        if (!msg || !msg.chat || typeof msg.text !== 'string') return;
        const fromChat = String(msg.chat.id);
        const bound = String(getChatId() || '');
        const parsed = parseCommand(msg.text);
        if (!parsed) return;

        if (!bound) {
            // Привязка только по /start с ключом из сборки.
            if (parsed.cmd !== '/start') return;
            const secret = String(getSecret() || '');
            if (!secret || parsed.args[0] !== secret) {
                await send(fromChat, 'Неверный ключ.');
                return;
            }
            bindChatId(fromChat);
            await send(fromChat, 'Подключено к TS Activity Keeper.\n\n' + HELP);
            return;
        }
        if (fromChat !== bound) return; // чужие чаты — молча мимо
        await handleCommand(parsed, fromChat);
    }
```

- [ ] **Step 4: Прогнать тест**

Run: `node --test test/telegram-bot.test.js`
Expected: PASS (17 тестов).

- [ ] **Step 5: Коммит**

```bash
git add src/telegram-bot.js test/telegram-bot.test.js
git commit -m "Pair Telegram chat by build secret and add argument commands"
```

---

## Task 8: Headless main.js и удаление UI

**Files:**
- Modify: `src/main.js` (полная перезапись)
- Delete: `src/renderer/` (весь каталог), `src/preload.js`, `src/tray-icon.js`, `test/tray-icon.test.js`

**Interfaces:**
- Consumes: всё, что произведено в задачах 1–7, плюс существующие `api-tracker`, `tracking-health`, `session-clock`, `auto-stop`, `credentials`, `utils`, `endpoints`.
- Produces: только процесс приложения; экспортов нет.

- [ ] **Step 1: Удалить UI-файлы**

```bash
git rm -r src/renderer
git rm src/preload.js src/tray-icon.js test/tray-icon.test.js
```

- [ ] **Step 2: Переписать `src/main.js` целиком**

```js
// Electron main process: headless-демон без единого окна и иконки.
// Всё общение с человеком идёт через Telegram (`telegram-bot.js`); здесь
// остаётся только оркестрация: трекинг-цикл, health, автостоп, keep-awake,
// автозапуск и wiring хендлеров бота.

const { app, powerSaveBlocker } = require('electron');
const axios = require('axios');
const { randomInt, formatDuration, formatSeconds, maskLogin } = require('./utils');
const credentials = require('./credentials');
const { HEALTH, initialHealthState, deriveHealth } = require('./tracking-health');
const { createSessionClock } = require('./session-clock');
const { createReminder } = require('./reminder');
const { createAutoStop } = require('./auto-stop');
const { createTelegramBot } = require('./telegram-bot');
const { createKeepAwake } = require('./keep-awake');
const { ensureAutostart, describeAutostart } = require('./launch-agent');
const { loadBuildSecrets } = require('./build-config-loader');
const settingsStore = require('./settings');
const { createApiTracker } = require('./api-tracker');
const { DEFAULT_DASHBOARD_URL } = require('./endpoints');

require('dotenv').config();

const VERSION = require('../package.json').version;
const secrets = loadBuildSecrets();
const startedAt = Date.now();

const config = {
    email: '',
    password: '',
    url: process.env.DASHBOARD_URL || DEFAULT_DASHBOARD_URL,
};

let running = false;
let durationTimer = null;
let heartbeatTimer = null;
let heartbeatErrors = 0;
let recoveryAttempts = 0;
let isQuitting = false;
let autostartResult = null;

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

let state = {
    status: 'Остановлен',
    action: '-',
    duration: '00:00:00',
    today: '--:--:--',
    week: '--:--:--',
    challenge: false,
    autoStopRemaining: null, // 'HH:MM:SS' пока автостоп взведён
};

// Сырой логин никогда не покидает main: всё пользовательское идёт через это.
function displayEmail() {
    if (!config.email) return '';
    return settingsStore.loadSettings().hideLogin ? maskLogin(config.email) : config.email;
}

const apiBackend = createApiTracker({
    dashboardUrl: config.url,
    getCredentials: () => ({ email: config.email, password: config.password }),
});

const backend = apiBackend;

// ---- Трекинг ---------------------------------------------------------------

async function startBot() {
    if (running) return 'Трекинг уже идёт.';
    if (!config.email || !config.password) return 'Нет аккаунта. Войди: /login <email> <пароль>';

    running = true;
    healthState = initialHealthState();
    sessionClock.reset();
    if (reminder) reminder.stop();
    armAutoStop();
    startDurationTimer();
    state.status = 'Запускается';
    state.action = 'Авторизация...';

    try {
        apiBackend.reset();
        const ok = await apiBackend.ensureAuth();
        if (!ok) {
            failStart('Авторизация не удалась — проверь логин и пароль');
            return 'Авторизация не удалась.';
        }
        state.status = 'Активен';
        state.action = 'Запуск трекинга...';
        startHeartbeatLoop();
        return 'Трекинг запускается.';
    } catch (e) {
        failStart(e.message);
        return 'Ошибка запуска: ' + e.message;
    }
}

function failStart(message) {
    state.status = 'Ошибка';
    state.action = message;
    running = false;
    stopDurationTimer();
    autoStop.disarm();
    state.autoStopRemaining = null;
    telegramNotify('❌ Ошибка авторизации: ' + message);
}

async function stopBot() {
    running = false;
    clearTimeout(heartbeatTimer);
    stopDurationTimer();
    if (reminder) reminder.stop();
    autoStop.disarm();
    state.autoStopRemaining = null;
    sessionClock.reset();
    healthState = initialHealthState();

    state.status = 'Остановлен';
    state.action = 'Остановка трекинга...';

    await backend.stop();

    trackingState.challengePending = false;
    state.action = '-';
    state.duration = '00:00:00';
    state.challenge = false;
}

function updateProgress(todaySeconds, weekSeconds) {
    if (typeof todaySeconds === 'number') state.today = formatSeconds(todaySeconds);
    if (typeof weekSeconds === 'number') state.week = formatSeconds(weekSeconds);
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
        state.status = 'Активен';
        if (!trackingState.challengePending) state.action = 'Время считается';
        if (reminder) reminder.restored();
    } else {
        // stalled, disconnected или connecting, разрешившийся в «не считается»
        sessionClock.pause();
        state.status = 'Не считается';
        const msg = next.health === HEALTH.STALLED ? 'сервер отвечает, но время не растёт' : 'нет связи с сервером';
        state.action = msg;
        if (reminder) reminder.notCounting(msg);
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

    // Часы за день/неделю приходят с дашборда и доступны, даже когда трекинг
    // не идёт — тянем их отдельно от heartbeat.
    if (typeof backend.fetchProgress === 'function') {
        try {
            const progress = await backend.fetchProgress();
            if (progress) updateProgress(progress.todaySeconds, progress.weekSeconds);
        } catch (e) {
            // best-effort, цикл не ломаем
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
            setChallenge(!!hb.challengePending);
        }
        processHealth({ hbOk: true, today });
    } catch (e) {
        heartbeatErrors++;
        console.error(`[TRACKING] Heartbeat error (${heartbeatErrors}/3):`, e.message);
        processHealth({ hbOk: false, today: null });
        if (heartbeatErrors >= 3) {
            heartbeatErrors = 0;
            if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
                console.error(`[TRACKING] Recovery attempts exhausted (${recoveryAttempts})`);
                state.action = 'Ошибка трекинга — нужна проверка';
                telegramNotify('🛑 Восстановить трекинг не удалось — нужна проверка вручную на Маке.');
            } else {
                recoveryAttempts++;
                console.log(`[TRACKING] Recovering (attempt ${recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS})...`);
                state.action = 'Восстановление трекинга...';
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

// Капча: сообщаем один раз на переход false -> true.
function setChallenge(pending) {
    const was = trackingState.challengePending;
    trackingState.challengePending = pending;
    state.challenge = pending;
    if (pending) {
        state.action = 'Капча — нужна проверка';
        if (!was) telegramNotify('🤖 Требуется проверка (капча) — зайди на дашборд с Мака.');
    }
}

function startDurationTimer() {
    stopDurationTimer();
    durationTimer = setInterval(() => {
        state.autoStopRemaining = autoStop.isArmed() ? formatDuration(autoStop.remainingMs()) : null;
        state.duration = formatDuration(sessionClock.elapsedMs());
        if (autoStop.expired()) onAutoStopExpired();
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
    state.autoStopRemaining = autoStop.isArmed() ? formatDuration(autoStop.remainingMs()) : null;
}

async function onAutoStopExpired() {
    autoStop.disarm();
    const settings = settingsStore.loadSettings();
    const andLogout = settings.autoStopLogout;
    telegramNotify(andLogout
        ? '⏱ Сработал автостоп — трекинг остановлен, аккаунт разлогинен.'
        : '⏱ Сработал автостоп — трекинг остановлен.');
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
    config.email = '';
    config.password = '';
    state.status = 'Остановлен';
    state.action = '-';
    state.today = '--:--:--';
    state.week = '--:--:--';
    state.duration = '00:00:00';
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
    if (telegramBot) telegramBot.notify(text);
}

function statusText() {
    const s = settingsStore.loadSettings();
    const lines = [
        `Статус: ${state.status}`,
        `Действие: ${state.action}`,
        `Сессия: ${state.duration}`,
        `Сегодня: ${state.today}`,
        `Неделя: ${state.week}`,
        `Логин: ${displayEmail() || '-'}`,
        `Автостоп: ${state.autoStopRemaining
            ? `через ${state.autoStopRemaining}${s.autoStopLogout ? ' (затем логаут)' : ''}`
            : 'выключен'}`,
        `Автозапуск: ${describeAutostart(autostartResult)}`,
        `Напоминания: ${s.remindMinutes ? `каждые ${s.remindMinutes} мин` : 'выкл'}`,
        `Keep-awake: ${keepAwake && keepAwake.isActive() ? 'активен' : 'неактивен'}`,
        `Аптайм: ${formatDuration(Date.now() - startedAt)} · версия ${VERSION}`,
    ];
    if (state.challenge) lines.push('⚠️ Требуется проверка (капча)');
    return lines.join('\n');
}

function startupText() {
    const trackingLine = config.email && config.password
        ? 'Трекинг: стартует'
        : 'Трекинг: ждёт /login <email> <пароль>';
    return [
        `▶️ TS Activity Keeper запущен (v${VERSION})`,
        trackingLine,
        `Автозапуск: ${describeAutostart(autostartResult)}`,
        `Keep-awake: ${keepAwake && keepAwake.isActive() ? 'активен' : 'неактивен'}`,
    ].join('\n');
}

function createTelegram() {
    telegramBot = createTelegramBot({
        request: (cfg) => axios(cfg),
        getToken: () => secrets.token,
        getSecret: () => secrets.secret,
        getChatId: () => settingsStore.loadSettings().telegramChatId,
        bindChatId: (chatId) => settingsStore.saveSettings({ telegramChatId: chatId }),
        handlers: {
            status: async () => statusText(),
            login: async (email, password) => {
                try {
                    credentials.save(email, password);
                } catch (e) {
                    return 'Не удалось сохранить аккаунт: ' + e.message;
                }
                config.email = email;
                config.password = password;
                if (running) await stopBot();
                return await startBot();
            },
            logout: async () => {
                await logout();
                return 'Вышел из аккаунта. Войти снова: /login <email> <пароль>';
            },
            pause: async () => {
                await stopBot();
                return 'Трекинг остановлен.';
            },
            resume: async () => startBot(),
            autostop: async (minutes, andLogout) => {
                settingsStore.saveSettings({ autoStopMinutes: minutes, autoStopLogout: andLogout });
                if (running) armAutoStop();
                return minutes
                    ? `Автостоп: через ${minutes} мин${andLogout ? ' с логаутом' : ''}.`
                    : 'Автостоп выключен.';
            },
            autostart: async (on) => {
                settingsStore.saveSettings({ autostart: on });
                autostartResult = ensureAutostart({ app, desired: on });
                return 'Автозапуск: ' + describeAutostart(autostartResult);
            },
            remind: async (minutes) => {
                settingsStore.saveSettings({ remindMinutes: minutes });
                return minutes
                    ? `Напоминания: каждые ${minutes} мин.`
                    : 'Напоминания выключены (сообщения о смене состояния остаются).';
            },
            hidelogin: async () => {
                settingsStore.saveSettings({ hideLogin: true });
                return 'Логин теперь маскируется: ' + displayEmail();
            },
            quit: async () => {
                isQuitting = true;
                app.isQuitting = true;
                app.quit();
            },
        },
        log: (msg) => console.error('[TELEGRAM]', msg),
    });
    if (secrets.token) telegramBot.start(); // висячий long-poll цикл
    else console.error('[TELEGRAM] токен не вшит в сборку — remote control отключён');
}

// ---- Запуск ----------------------------------------------------------------

app.whenReady().then(async () => {
    if (app.dock) app.dock.hide();

    keepAwake = createKeepAwake({
        blocker: powerSaveBlocker,
        log: (msg) => console.error('[KEEP-AWAKE]', msg),
    });
    keepAwake.start();

    const settings = settingsStore.loadSettings();
    autostartResult = ensureAutostart({ app, desired: settings.autostart });
    if (!autostartResult.ok) {
        console.error('[AUTOSTART]', describeAutostart(autostartResult));
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
    if (hasAccount) setTimeout(startBot, 2000);
});

app.on('window-all-closed', (e) => {
    e.preventDefault();
});

app.on('before-quit', (e) => {
    if (telegramBot) telegramBot.stop();
    if (keepAwake) keepAwake.stop();
    if (isQuitting) return;
    if (running) {
        isQuitting = true;
        app.isQuitting = true;
        e.preventDefault();
        running = false;
        if (reminder) reminder.stop();
        clearTimeout(heartbeatTimer);
        stopDurationTimer();
        Promise.race([
            backend.stop(4000),
            new Promise((resolve) => setTimeout(resolve, 5000)),
        ]).finally(() => app.quit());
    }
});
```

- [ ] **Step 3: Проверить, что весь набор тестов зелёный**

Run: `npm test`
Expected: PASS — файлы `notifier`/`tray-icon` больше не тестируются, все остальные наборы проходят.

- [ ] **Step 4: Проверить, что не осталось ссылок на удалённые модули**

Run: `grep -rn "renderer\|preload\|tray-icon\|notifier\|ipcMain\|BrowserWindow\|telegramToken" src/ test/ --include=*.js`
Expected: пусто (ни одного совпадения).

- [ ] **Step 5: Живой прогон приложения**

Run: `TELEGRAM_BOT_TOKEN=<реальный токен> TELEGRAM_SECRET=devsecret npm run dev`
Expected:
- в Dock и меню-баре пусто, окон нет;
- в Telegram: `/start devsecret` → приветствие со списком команд;
- `/status` → блок статуса со строками «Автозапуск», «Keep-awake: активен», «Аптайм»;
- `pmset -g assertions | grep PreventUserIdleDisplaySleep` показывает ненулевой счётчик;
- `/quit` завершает процесс.

Остановить: `/quit` в чате.

- [ ] **Step 6: Коммит**

```bash
git add src/main.js
git commit -m "Rewrite main process as headless Telegram-controlled daemon"
```

---

## Task 9: Документация

**Files:**
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: итоговое поведение из задач 1–8.
- Produces: ничего исполняемого.

- [ ] **Step 1: Прочитать текущий README**

Run: `cat README.md`
Expected: видно старые разделы про меню-бар, окно входа и настройки в UI — их надо заменить.

- [ ] **Step 2: Переписать README**

Заменить разделы про UI на разделы ниже (структуру и стиль остального README сохранить):

- **Что это** — фоновое приложение без интерфейса; управление только через Telegram.
- **Сборка**: `npm install`, затем `npm run build` — скрипт спросит `Telegram bot token` (от @BotFather) и ключ привязки; если ключ не ввести, он сгенерится и будет напечатан. Для неинтерактивной сборки: `TELEGRAM_BOT_TOKEN=... TELEGRAM_SECRET=... npm run build`. Готовый `.dmg` в `dist/`.
- **Установка**: перетащить `.app` в `/Applications` и запустить оттуда — иначе автозапуск не сохранится (App Translocation). Про Gatekeeper «Open Anyway» оставить существующий текст.
- **Первый запуск**: приложение невидимо (нет иконки в Dock и меню-баре); в боте отправить `/start <ключ>`, затем `/login <email> <пароль>`.
- **Команды** — полный список из `HELP` (см. Task 7).
- **Keep-awake** — пока приложение запущено, Mac не засыпает и экран не гаснет; это не отменяет ручную блокировку экрана (Cmd+Ctrl+Q), закрытие крышки и корпоративные политики принудительного логаута.
- **Автозапуск** — приложение само пробует прописаться в объекты входа и сообщает результат в Telegram при старте; при отказе — разрешить в Системных настройках → Основные → Объекты входа.
- **Разработка**: `npm start` / `npm run dev` берут токен из `.env` (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_SECRET`), `npm test` — весь набор тестов.

- [ ] **Step 3: Обновить CLAUDE.md**

Внести правки:
- В «Big picture» убрать упоминание menu-bar и заменить на: фоновый (LSUIElement) демон без окон; единственный интерфейс — Telegram.
- Секцию «Tracking health → UI/notifications» переименовать в «Tracking health → Telegram» и заменить `notifier` на `reminder.js`, убрать упоминания трея и `sessionClock`-индикации в UI (сам `sessionClock` оставить).
- Секцию «UI» удалить целиком; вместо неё добавить «Telegram-only control»: `telegram-bot.js` + `commands.js`, привязка чата по `/start <секрет>`, хендлеры возвращают текст ответа.
- В «Config & credentials» добавить, что токен бота больше не в `config.json`, а в `src/build-config.js` (генерится `build/prepare-secrets.js`, в `.gitignore`, читается через `build-config-loader.js`).
- Добавить секцию «Keep-awake & autostart»: `keep-awake.js` (`prevent-display-sleep`, весь аптайм) и `launch-agent.js` (попытка + перечитывание настройки + причина `location` для translocated-сборок).
- В «Commands» добавить, что `npm run build` через `prebuild` спрашивает токен.

- [ ] **Step 4: Финальная проверка**

Run: `npm test && grep -rn "tray\|renderer\|notifier" README.md CLAUDE.md`
Expected: тесты PASS; в документации не осталось упоминаний трея, renderer и notifier.

- [ ] **Step 5: Коммит**

```bash
git add README.md CLAUDE.md
git commit -m "Document headless Telegram-only workflow"
```

---

## Проверка покрытия спеки

| Раздел спеки | Задача |
|---|---|
| Удаление UI-файлов и Electron-виджетов | 3, 8 |
| Новые модули (`commands`, `reminder`, `keep-awake`, `launch-agent`, `build-config*`) | 2–6 |
| Сборка и секреты, `LSUIElement`, версия 0.0.4 | 6 |
| Привязка чата по `/start <секрет>` | 7 |
| Полный список команд, удаление `/revoke` | 7 |
| Формат `/status` | 8 |
| Инициативные сообщения (старт, health, капча, авторизация, автостоп) | 3, 8 |
| Настройки и их sanitize | 1 |
| Keep-awake весь аптайм | 4, 8 |
| Автозапуск: попытка, проверка, отчёт в Telegram | 5, 8 |
| Обработка ошибок (авторизация, recovery, отсутствие токена) | 7, 8 |
| Тесты по всем новым модулям | 1–7 |
| README и CLAUDE.md | 9 |
