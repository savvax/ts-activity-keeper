# TS Activity Keeper

A macOS menu-bar (Electron) app that keeps your dashboard session active and reports tracked time.

The app lives in the menu bar. Click the tray icon to open the control panel, sign in, and pick a
tracking mode.

## Features

- Menu-bar app with a live tray clock icon
- Sign-in via Gitea OAuth; credentials are stored **encrypted in the macOS Keychain** (never in plaintext)
- Three tracking modes:
  - **window** — visible browser window
  - **background** — hidden window
  - **api** — headless HTTP heartbeats, no browser window
- Activity emulation: mouse movement, scrolling, safe clicks, periodic page refresh
- Tracking-health monitoring (counting / stalled / disconnected states)
- Session persistence (cookies survive restarts)

## Requirements

- macOS (Apple Silicon / arm64)
- Node.js v18+
- npm

## Setup

```bash
npm install
```

No `.env` file is required. Credentials are entered in the app's sign-in window on first launch and
stored in the macOS Keychain.

> Optional overrides via environment variables (both have sensible defaults):
> - `DASHBOARD_URL` — dashboard base URL (has a built-in default)
> - `HEADLESS` — `true` to start in background mode

## Running

```bash
npm start          # launch the app
npm run dev        # launch with Electron logging enabled
```

The app appears in the macOS menu bar. Click the tray icon to open the control panel, sign in, and
start tracking.

## Testing

```bash
npm test           # run the test suite (node --test)
```

## Building the .dmg

The build is handled by [electron-builder](https://www.electron.build/) and is configured in the
`build` section of `package.json` (target: `dmg`, arm64).

```bash
npm run build
```

The installer is written to `dist/`:

```
dist/TS Activity Keeper-3.0.0-arm64.dmg
```

The app icon is read from `build/icon.icns`. To open the result:

```bash
open "dist/TS Activity Keeper-3.0.0-arm64.dmg"
```

Then drag **TS Activity Keeper** into Applications.

> Note: builds are unsigned by default. On first launch macOS Gatekeeper may block the app —
> right-click the app and choose **Open**, or allow it under
> *System Settings → Privacy & Security*.
