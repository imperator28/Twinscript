# W0 evidence — 2026-07-30

```text
Commit:                        4a3f7be2 (codex/phase-0-phase-1) plus the
                               uncommitted W0 changes listed below
Build type:                    development + unsigned installer
Windows edition/version/build: Windows 11 Enterprise, 25H2, build 26200
Architecture:                  x64
Display scaling/monitor layout: not varied in this run — W1 item
Microphone:                    not exercised — W1 item
Playback device:               not exercised — W1 item
Meeting client and version:    not exercised — W1 item
OBS version:                   n/a
OpenAI model/profile:          none; no key used, no API call made
Glossary configuration:        default built-in
Tester:                        maintainer
Date/time/timezone:            2026-07-30, America/Los_Angeles
Node / npm:                    v24.14.0 / 11.9.0
```

Node 24 rather than the documented Node 20 LTS. CI still pins Node 20, so the
Node-20 result is unproven on this machine.

## Changes under test

| Area | Change |
| --- | --- |
| `scripts/copy-ort-wasm.cjs` | Cross-platform replacement for `copy-ort-wasm.sh`; `postinstall` calls it with `node`. |
| `vitest.config.ts` | Pinned `include`/`exclude` so Vitest and `node --test` no longer collect each other's files. |
| `electron/captions/squirrel-startup.js` | Squirrel install/update/uninstall/obsolete handling and the AppUserModelID. |
| `electron/captions/app-lifecycle.js` | Closing the control window ends the app on Windows and Linux. |
| `forge.config.js` | Packaged WASM narrowed to `ort` + `gtcrn`; `iconUrl` repointed at this repository. |
| `.github/workflows/windows-ci.yml` | Windows validation gate with an unsigned installer artifact on every branch, PR, and manual run. |
| `.gitattributes` | `public/wasm/** -text`, so `npm ci` stops leaving phantom modifications on a `core.autocrlf=true` checkout. |
| `src/captions/captureHealth.ts` | W1: platform-correct degraded-capture guidance and per-channel liveness. |
| `electron/captions/overlay-layout.js` | W1: clamped overlay geometry plus layout reapplied on display changes. |

## W0 — build, package, and install

| Check | Result | Observation |
| --- | --- | --- |
| Clean dependency install | PASS | `npm ci` exit 0 in PowerShell with no manual step. `postinstall` ran `electron-rebuild` (no native modules) and copied 7 ORT WASM files. |
| Caption tests | PASS | `npm run test:captions` exit 0 — 68 tests, 0 failures. |
| Component/unit tests | PASS | `npx vitest run` exit 0 — 148 files, 1641 tests. Was 7 failed files / 16 failed tests before the discovery fix. |
| Production build | PASS | `npm run build` exit 0. |
| Development launch | PASS | `npm run dev` started Vite on 5173 and an Electron control window titled `Twinscript`. |
| Forge make | PASS | `out/make/squirrel.windows/x64/` holds `Twinscript-0.1.0 Setup.exe` (140,327,424 bytes), `Twinscript-0.1.0-full.nupkg`, and `RELEASES`. |
| Fresh install | PASS | `Setup.exe` run as the standard user with no UAC prompt. Installed to `%LOCALAPPDATA%\Twinscript` (`app-0.1.0`, `packages`, stub exe, `Update.exe`). Desktop and Start Menu (`Programs\Jiyu Qian\`) shortcuts created, both targeting the stub exe with `app-0.1.0` as working directory. `HKCU` uninstall entry registered as "Twinscript" 0.1.0, publisher "Jiyu Qian". |
| Squirrel events | PASS | Sampled every 500 ms across the whole install: at most **one** top-level app window at any moment. The `--squirrel-install` launch (3 → 1 processes) created zero windows; the following `--squirrel-firstrun` launch created one. Uninstall created zero windows. `Squirrel-Shortcut.log` confirms one `--createShortcut` run. |
| Taskbar lifecycle | PARTIAL | With captions shown, three visible top-level windows exist: two `WS_EX_TOPMOST` caption windows and the non-topmost control window. Electron implements `skipTaskbar` on Windows via `ITaskbarList::DeleteTab` rather than `WS_EX_TOOLWINDOW`, so taskbar absence cannot be asserted programmatically — needs one visual confirmation. |
| Exit | PASS after fix | Before the fix, closing the control window left 7 processes alive. After it, 0 remain — verified both on the unpacked build and on the installed build with both caption windows visible. |
| Credential safety | PARTIAL | `caption-settings.json` (7,181 bytes) persisted across a restart from the installed shortcut and contains no key material; no credential file exists until a key is saved. Saving a real key, restarting, and confirming no repeated prompt is the owner's step. |
| Secret scan | PASS | `git grep` found no key in tracked files; `git log -S"sk-proj"` found none in history; scanning every file under `out/make` for `sk-[A-Za-z0-9]{32,}` and `sk-(proj\|svcacct\|admin)-…` found none. |
| Uninstall | PASS | `Update.exe --uninstall` removed both shortcuts and the `HKCU` uninstall entry and marked the install `.dead`. Zero residual processes. |

## Installed-app observations

- **Layout math is correct on this multi-monitor setup.** Primary display work
  area `0,0 2560x1392`; a second display sits at `0,1440`. Stacked layout placed
  both 1120×142 windows at `x=720` — centered — with the Chinese window's lower
  edge at 1364 (the 28 px margin) and the English window 10 px above it.
- **Caption windows start hidden by design.** `createAll()` builds them with
  `show: false`; `captions:session-start` and the **Show captions** control (or
  `Ctrl+Shift+C`) reveal them. The first-run smoke list in
  [`../../developer-setup.md`](../../developer-setup.md) reads as though they are
  visible at launch; they are not, and that is intended.
- **Squirrel leaves residue after uninstall.** `Update.exe`, a stripped
  `app-0.1.0` holding `squirrel.exe` and `v8_context_snapshot.bin`, and the empty
  `Programs\Jiyu Qian\` folder remain. This is standard Squirrel.Windows
  behavior — it cannot delete its own running `Update.exe` — not an app defect.
- **`DisplayIcon` is empty** in the uninstall registry entry, so Add/Remove
  Programs shows the app without an icon. Cosmetic; worth setting during W5.
- User data under `%APPDATA%\Twinscript` correctly survives
  uninstall.

## W1 geometry cross-check

The overlay placement refactor is behavior-preserving on this machine. While the
packaged pre-refactor build was running, the two stacked overlays measured
`x=720 y=1070 1120x142` and `x=720 y=1222 1120x142` on a primary work area of
`0,0 2560x1392`. `computeOverlayBounds` returns exactly those bounds for that work
area, and `1247`-wide halves at `y=1190` for side-by-side.

This is a numeric equivalence check, not a fresh on-screen measurement: Windows
blocked `SetForegroundWindow` from the automation process, so the `Ctrl+Shift+C`
accelerator could not be delivered to the dev-mode window. One visual pass over
both layouts after the refactor is still worth doing.

## Packaged contents verified

`out/Twinscript-win32-x64/resources/`:

- `app.asar` — 65,316,912 bytes, 343 entries: `package.json`, `dist-electron/`
  (all 17 caption modules plus `captions-main.js` and `captions-preload.js`),
  `build/`, pruned `node_modules/`.
- `assets/` and `resources/` as extra resources.

WASM directories inside the asar: `build/wasm/ort` and `build/wasm/gtcrn` only.
`sherpa-onnx-asr`, `sherpa-onnx-asr-stream`, `sherpa-onnx-tts`, `piper-plus`,
and `vad` are excluded — about 37 MB that no built artifact references.

## Remaining before W0 passes

Three items, all needing a human at the machine:

1. **Visual taskbar check.** Confirm the control window has a taskbar button and
   neither caption window does.
2. **Credential round trip.** Save a real API key in Settings, use **Test saved
   key**, restart the app, and confirm it loads with no repeated prompt and
   appears in no settings file or log.
3. **Secure-storage recovery.** Exercise the platform-specific unlock message and
   the scoped **Repair secure storage** action, then confirm it removed only the
   OpenAI credential and left glossaries and preferences intact.

Deferred, not blocking: re-run the command set on Node 20 to match CI.
