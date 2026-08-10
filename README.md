# TS Activity Keeper

A headless background (Electron) app for macOS that keeps your dashboard session active and
reports tracked time. The app has **no UI** — no menu-bar icon, no windows, no Dock icon — it
runs invisibly in the background and is controlled entirely through **Telegram**.

## Quick start — build from source

Build and install in a few commands (macOS, Apple Silicon):

```bash
git clone https://github.com/savvax/ts-activity-keeper.git
cd ts-activity-keeper
npm install
npm run build
open "dist/mac-arm64/TS Activity Keeper.app"
```

`npm run build` produces the ready-to-run **TS Activity Keeper.app** in `dist/mac-arm64/` — no
`.dmg` packaging, so it works everywhere including MDM-managed Macs where mounting disk images is
blocked by policy. The build runs an interactive prebuild step that asks for a **Telegram bot
token** (from [@BotFather](https://t.me/BotFather)) and a pairing key — see
[Building the app](#building-the-app). It is ad-hoc signed automatically, so it won't show the
*"app is damaged"* error. (If you instead copy the built app to **another** Mac, see
[Installing a transferred build](#installing-a-transferred-build) for the one-time Gatekeeper step.)

The app is launched straight from `dist/mac-arm64/` — no copying required, which is what you want
on Macs where writing to **/Applications** is blocked by policy. Once launched it runs in the
background and does not need the terminal, so you can close it afterwards.

The one thing you give up is autostart at login: macOS only keeps the login item if the app lives
in `/Applications`. If you *can* write there, copy it over and launch from there instead — see
[Autostart](#autostart).

**Then open Telegram and send `/start <pairing key>` to the bot** (the key is printed during the
build), followed by `/login <email> <password>` to sign in and start tracking — see
[First run](#first-run) and [Telegram commands](#telegram-commands).

## Features

- Fully headless — no Dock icon, no menu bar, no windows (`LSUIElement`); the only interface is
  a Telegram bot
- Headless **API tracking** — replays the Gitea OAuth flow and sends tracking heartbeats over HTTP, with no browser window
- Tracking-health monitoring (counting / stalled / disconnected states) with Telegram reminders
- Keeps the Mac awake and the display on for as long as the app is running
- Attempts to register itself as a macOS login item and reports the result over Telegram
- Session persistence (cookies survive restarts)

## Requirements

- macOS (Apple Silicon / arm64)
- Node.js v18+
- npm
- A Telegram bot token (create one via [@BotFather](https://t.me/BotFather))

## Setup

```bash
npm install
```

No `.env` file is required to run a built app — the bot token and pairing key are baked into the
build (see [Building the app](#building-the-app)). For local development, see
[Development](#development).

> Optional override via environment variable:
> - `DASHBOARD_URL` — dashboard base URL (has a built-in default)

## First run

The app has no visible window, Dock icon, or menu-bar icon — after launching it, open Telegram
and talk to the bot:

1. Send `/start <pairing key>` (the key printed during `npm run build`) — this binds your chat to
   the app. The bot answers only this one chat from then on.
2. Send `/login <email> <пароль>` to sign in and start tracking.

## Telegram commands

```
/status — статус, часы за сегодня и неделю
/login <email> <пароль> — войти в аккаунт и запустить трекинг
/logout — выйти из аккаунта (трекинг останавливается)
/pause — остановить трекинг
/resume — запустить трекинг
/autostop <минуты> [logout] — таймер автостопа, /autostop off — выключить
/autostart on|off — автозапуск при входе в macOS
/remind <минуты>|off — как часто напоминать, что время не считается
/hidelogin — маскировать логин в ответах (обратно не выключается)
/quit — выйти из приложения на Маке
/help — это сообщение
```

## Keep-awake

While the app is running, it prevents the Mac's display from sleeping so tracking never stalls
because the screen turned off. This does **not** override a manual screen lock, closing the lid,
or a corporate policy that forces a logout — those still happen normally.

## Autostart

On every launch the app tries to register itself as a macOS login item and reports the actual
result in Telegram (enabled / already enabled / failed and why). If it can't enable it
automatically, allow it manually in **System Settings → General → Login Items**. If the app isn't
running from `/Applications` (e.g. straight from `dist/mac-arm64/` or `~/Downloads`), autostart
won't persist and the app reports it — copy it to `/Applications` and launch it from there:

```bash
cp -R "dist/mac-arm64/TS Activity Keeper.app" /Applications/
open "/Applications/TS Activity Keeper.app"
```

If your Mac doesn't allow writing to `/Applications`, everything else keeps working — you just
have to launch the app yourself after a reboot.

## Development

```bash
npm start          # launch the app, token/key from .env
npm run dev         # same, with Electron logging enabled
```

`npm start` / `npm run dev` read `TELEGRAM_BOT_TOKEN` and `TELEGRAM_SECRET` from a local `.env`
file (via `dotenv`) instead of the baked-in `src/build-config.js`.

## Testing

```bash
npm test           # run the test suite (node --test)
```

## Building the app

The build is handled by [electron-builder](https://www.electron.build/) and is configured in the
`build` section of `package.json` (target: `dir`, arm64). It produces the app directly, without
`.dmg` packaging — so it never trips over `hdiutil` and works on MDM-managed Macs too.

```bash
npm run build
```

Before packaging, the `prebuild` script (`build/prepare-secrets.js`) makes sure a bot token is
available:

- If `TELEGRAM_BOT_TOKEN` (and optionally `TELEGRAM_SECRET`) are set in the environment, they are
  used non-interactively — handy for CI:

  ```bash
  TELEGRAM_BOT_TOKEN=... TELEGRAM_SECRET=... npm run build
  ```

- Otherwise, if `src/build-config.js` already exists from a previous build, it's reused.
- Otherwise, the script asks interactively for the **Telegram bot token** and an optional
  **pairing key** (used to activate `/start <key>` on first run) — leave the key blank and one is
  generated and printed for you.
- Without a token, the build is aborted — a build with no token can't be controlled.

The generated `src/build-config.js` is not committed (`.gitignore`d) — it exists only on the
machine that built the app.

The app is written to `dist/mac-arm64/`:

```
dist/mac-arm64/TS Activity Keeper.app
```

The app icon is read from `icon.icns` in the repo root. Launch it in place:

```bash
open "dist/mac-arm64/TS Activity Keeper.app"
```

Copying it to `/Applications` is optional and only matters for [autostart](#autostart).

The build is **ad-hoc code-signed** automatically via the `build/afterPack.js` hook. This
replaces Electron's weak linker-generated signature with a full deep signature, which prevents
the misleading *"the app is damaged and can't be opened"* Gatekeeper error.

## Installing a transferred build

An app you build locally has no quarantine attribute, so it just launches. But if you copy the
`.app` to another Mac (AirDrop, download, archive), macOS adds a quarantine attribute and — since
the app is ad-hoc signed but **not notarized** — Gatekeeper warns you on the **first launch**. To
open it:

1. Put **TS Activity Keeper.app** wherever you want to run it from (**/Applications** if you can
   write there — that's what autostart needs; any other folder works otherwise).
2. **Right-click** the app in Finder and choose **Open**, then confirm **Open** in the dialog.
3. After the first successful launch, the app opens normally every time.

### macOS Sequoia (15) and later

On Sequoia the right-click → Open shortcut no longer bypasses Gatekeeper. Instead you'll see:

> **"Apple could not verify "TS Activity Keeper.app" is free of malware that may harm your Mac
> or compromise your privacy."**

This is expected for an un-notarized app — it is **not** an actual malware detection. To open it:

1. Double-click the app, then click **Done** on the warning (do **not** click *Move to Trash*).
2. Open **System Settings → Privacy & Security** and scroll down to the **Security** section.
3. Next to *"TS Activity Keeper" was blocked…* click **Open Anyway**.
4. Authenticate with Touch ID / your password, then click **Open Anyway** again in the dialog.
5. After this one-time approval, the app launches normally on every subsequent open.

Alternatively, remove the quarantine flag from the terminal:

```bash
xattr -dr com.apple.quarantine "TS Activity Keeper.app"
```

> To remove the Gatekeeper prompt entirely, the app would need a Developer ID signature and
> Apple notarization (requires a paid Apple Developer account).
