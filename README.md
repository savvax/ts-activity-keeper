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
dist/TS Activity Keeper-0.0.2-arm64.dmg
```

The app icon is read from `build/icon.icns`. To open the result:

```bash
open "dist/TS Activity Keeper-0.0.2-arm64.dmg"
```

Then drag **TS Activity Keeper** into Applications.

The build is **ad-hoc code-signed** automatically via the `build/afterPack.js` hook. This
replaces Electron's weak linker-generated signature with a full deep signature, which prevents
the misleading *"the app is damaged and can't be opened"* Gatekeeper error.

## Installing a downloaded build

The app is ad-hoc signed but **not notarized**, so when you download the `.dmg` from GitHub
macOS adds a quarantine attribute. On the **first launch** Gatekeeper will still warn you. To
open it:

1. Open the `.dmg` and drag **TS Activity Keeper** into **Applications**.
2. **Right-click** the app in Applications and choose **Open**, then confirm **Open** in the dialog.
   - On recent macOS (Sequoia and later), instead open it once, then go to
     **System Settings → Privacy & Security** and click **Open Anyway**.
3. After the first successful launch, the app opens normally every time.

Alternatively, remove the quarantine flag from the terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/TS Activity Keeper.app"
```

> To remove the Gatekeeper prompt entirely, the app would need a Developer ID signature and
> Apple notarization (requires a paid Apple Developer account).
