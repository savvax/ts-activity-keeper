# Headless Telegram-only TS Activity Keeper — design

Дата: 2026-08-10
Версия приложения после изменений: 0.0.4

## Цель

Превратить menu-bar приложение в невидимый фоновый демон. Весь UI и любые
локальные индикации удаляются; единственный интерфейс — Telegram-бот, токен
которого вшивается в сборку. Дополнительно приложение держит Mac бодрствующим,
чтобы система не уснула и не разлогинила пользователя по бездействию.

## Итоговое поведение

- Приложение запускается фоново (`LSUIElement`), не появляется ни в Dock, ни в
  Cmd+Tab, ни в меню-баре.
- Если аккаунт уже сохранён — авторизация и трекинг стартуют сразу, без команд.
- Если аккаунта нет — процесс молча живёт и ждёт `/start <секрет>` и `/login`.
- Всё управление и все уведомления идут через один привязанный Telegram-чат.
- Пока процесс жив, macOS не засыпает и экран не гаснет.

## Архитектура

### Удаляется

- `src/renderer/` целиком (`index.html`, `renderer.js`, `setup.html`,
  `setup.js`, `styles.css`)
- `src/preload.js`, `src/tray-icon.js`, `src/notifier.js`
- `test/tray-icon.test.js`, `test/notifier.test.js`
- Из `main.js`: `Tray`, `BrowserWindow`, `Notification`, `dialog`,
  `nativeImage`, `nativeTheme`, все `ipcMain` handlers, PNG-энкодер
  (`crc32` / `pngChunk` / `pngFromRgba`), `createTrayIcon`, `refreshTrayIcon`,
  `showControlWindow`, `showSetupWindow`, `sendToControl`
- Команда бота `/revoke`

### Остаётся без изменений

`api-tracker.js`, `tracking-health.js`, `session-clock.js`, `auto-stop.js`,
`config-store.js`, `credentials.js`, `endpoints.js`, `paths.js`, `utils.js`
и их существующие тесты. Механика трекинга и health-машина не трогаются.

### Новые модули

| Модуль | Назначение | Тест |
|---|---|---|
| `src/build-config.js` | генерится при сборке: `{ TELEGRAM_BOT_TOKEN, PAIRING_SECRET }`; в `.gitignore` | — |
| `src/build-config.example.js` | шаблон в репозитории | — |
| `src/commands.js` | чистый парсер команд и аргументов | `test/commands.test.js` |
| `src/reminder.js` | повторные напоминания в Telegram (замена `notifier.js`) | `test/reminder.test.js` |
| `src/keep-awake.js` | обёртка над `powerSaveBlocker` с инъекцией | `test/keep-awake.test.js` |
| `src/launch-agent.js` | `app.setLoginItemSettings` для `/autostart` | — (Electron-зависимый) |
| `build/prepare-secrets.js` | prebuild: спрашивает/пишет `build-config.js` | — |

`main.js` остаётся оркестратором, но теперь только: трекинг-цикл, health,
auto-stop, keep-awake и wiring Telegram-хендлеров.

## Сборка и секреты

`npm run build` → `prebuild` запускает `build/prepare-secrets.js`:

1. Если заданы `TELEGRAM_BOT_TOKEN` (и опционально `TELEGRAM_SECRET`) в ENV —
   молча записать `src/build-config.js` и выйти (CI не зависает).
2. Иначе, если `src/build-config.js` существует и токен непустой — оставить
   как есть, вывести какой токен используется (маскированно).
3. Иначе — интерактивно спросить в терминале bot token; пустой ввод прерывает
   сборку с ненулевым кодом. Затем спросить секрет-фразу; пустой ввод →
   сгенерировать случайную (`crypto.randomBytes`) и распечатать её в конце
   сборки, чтобы владелец мог ей воспользоваться.

`src/build-config.js` попадает в бандл через уже существующий `files: ["src/**/*"]`.

Дев-режим (`npm start`): если `build-config.js` отсутствует, значения берутся
из `.env` (`dotenv` уже подключён). При пустом токене бот не стартует,
в консоль пишется предупреждение, трекинг при этом работает нормально.

Ключ `telegramToken` из `config.json` удаляется — единственный источник токена
это сборка.

## Telegram

### Привязка

Бот отвечает ровно одному чату. Пока `telegramChatId` пуст, единственная
принимаемая команда — `/start <секрет>`:

- секрет совпал → чат сохраняется в `config.json`, в ответ приветствие и `/help`;
- секрет не совпал или отсутствует → одна нейтральная строка «Неверный ключ»,
  ничего о приложении не раскрывается;
- любые другие сообщения от непривязанных чатов игнорируются молча.

После привязки сообщения из других чатов игнорируются молча (как сейчас).

### Команды

```
/start <секрет>            привязать чат
/login <email> <пароль>    сохранить аккаунт и запустить трекинг
/logout                    выйти из аккаунта, трекинг стоп; вернуться через /login
/status                    полный статус (см. ниже)
/pause                     остановить трекинг
/resume                    запустить трекинг
/autostop <мин> [logout]   таймер автостопа; /autostop off — выключить
/autostart on|off          автозапуск при входе в macOS
/remind <мин>|off          период повторных напоминаний
/hidelogin                 включить маскировку логина (одностороннее)
/quit                      выйти из приложения (с предупреждением)
/help                      список команд
```

`/login` требует привязанного чата. `/quit` отвечает предупреждением, что
запустить приложение обратно можно только физически с Мака.

### Формат `/status`

```
Статус: Active | Not counting | Stopped
Действие: <текущее действие>
Сессия: HH:MM:SS
Сегодня: HH:MM:SS
Неделя: HH:MM:SS
Логин: <email или маска>
Автостоп: через HH:MM:SS (затем логаут) | выключен
Автозапуск: вкл | выкл
Напоминания: каждые N мин | выкл
Keep-awake: активен | неактивен
Аптайм: HH:MM:SS · версия 0.0.4
```

При активной капче добавляется строка предупреждения.

### Инициативные сообщения

Отправляются только в привязанный чат; если чат не привязан — не копятся.

- старт приложения (в том числе после ребута/автозапуска);
- переход `counting` ⇄ «время не считается» (по `deriveHealth`, логика машины
  не меняется) — сообщение о проблеме и о восстановлении;
- повторные напоминания раз в `remindMinutes`, пока время не считается
  (`remindMinutes = 0` отключает повторы, первое сообщение о смене состояния
  всё равно приходит);
- капча / исчерпание попыток recovery;
- ошибка авторизации;
- срабатывание автостопа.

## Настройки

`settings.js` DEFAULTS:

```js
{
  hideLogin: false,       // одностороннее включение
  autoStopMinutes: 0,     // 0 = выключено
  autoStopLogout: false,
  remindMinutes: 5,       // 0 = без повторов
  autostart: true,
  telegramChatId: '',
}
```

Удаляются `notifySound`, `notifyReminderMinutes`, `telegramToken` вместе с их
ветками в `sanitize`. Хранилище прежнее: `config.json` через `config-store`
(merge-запись), пароль через `safeStorage`. `test/settings.test.js`
обновляется под новый набор ключей.

`autostart` применяется через `app.setLoginItemSettings({ openAtLogin })` при
старте приложения и при каждом изменении настройки.

## Keep-awake

`src/keep-awake.js` — идемпотентная обёртка:

```js
createKeepAwake({ blocker })  // { start, stop, isActive }
```

`blocker` инжектится (`powerSaveBlocker` в проде, фейк в тесте), режим
`prevent-display-sleep`. Повторный `start()` не создаёт второй id.

В `main.js` вызывается один раз в `app.whenReady()` и снимается в
`before-quit`. Пауза, логаут и остановка трекинга на него не влияют.

Ограничения (документируются в README): не отменяет ручную блокировку экрана,
закрытие крышки и корпоративные политики принудительного логаута — только
сон системы, гашение экрана и авто-логаут по бездействию.

## Обработка ошибок

- Ошибка авторизации при `/login` → трекинг не стартует, в чат уходит причина,
  credentials не сохраняются.
- Ошибка авторизации в рантайме → сообщение в чат, поведение цикла как сейчас
  (recovery до `MAX_RECOVERY_ATTEMPTS`, затем пауза recovery).
- Сбой сети Telegram → существующий backoff в `telegram-bot.js` (5 с) без
  влияния на трекинг.
- Отсутствие токена в сборке → приложение работает как трекер без remote
  control, ошибка в консоль.

## Тестирование

`npm test` (node --test) должен оставаться зелёным.

- `commands.test.js` — парсинг всех команд и аргументов, включая мусорный ввод.
- `reminder.test.js` — первое сообщение, повторы по интервалу, «восстановлено»,
  `remindMinutes = 0`.
- `keep-awake.test.js` — идемпотентность start/stop, режим блокировки.
- `telegram-bot.test.js` — привязка по секрету (успех/провал/чужой чат),
  диспетчеризация команд с аргументами, отсутствие `/revoke`.
- `settings.test.js` — новый набор ключей и sanitize.

## Документация

- README переписывается: сборка с вводом токена, первый `/start <секрет>`,
  полный список команд, ограничения keep-awake, отсутствие UI.
- CLAUDE.md: секции про UI/tray/notifier заменяются на headless + Telegram,
  добавляются `build-config`, `commands`, `reminder`, `keep-awake`.
- `package.json`: версия 0.0.4, `prebuild`, `mac.extendInfo.LSUIElement: true`.
