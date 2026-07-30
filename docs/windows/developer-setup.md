# Windows developer setup

This guide creates a reproducible Windows 11 x64 development environment. Use
native Windows for the first validation; do not treat a macOS cross-build or a
Windows VM without real audio devices as audio evidence.

## 1. Machine baseline

Use:

- Windows 11 22H2 or newer, x64;
- a non-administrator daily user account that can approve UAC when necessary;
- a physical microphone or USB headset;
- headphones, so meeting playback is not captured again by the microphone;
- one real meeting client, initially Microsoft Teams or Zoom; and
- a stable internet connection.

Record the output of `winver`, the CPU architecture, the microphone model, the
playback-device model, and the meeting-client version in the validation report.

Windows 10 is a later compatibility check. Windows on Arm is deferred until the
x64 client passes W3.

## 2. Install the toolchain

Install:

1. Git for Windows.
2. Node.js 20 LTS. The repository's GitHub Actions workflow also uses Node 20.
3. Visual Studio 2022 Build Tools with:
   - **Desktop development with C++**;
   - MSVC v143 x64/x86 build tools; and
   - a current Windows 11 SDK.
4. PowerShell 7 is recommended but not required.

Do not install VB-CABLE. It belongs to retained Sokuji voice-routing code and is
not part of this subtitle or camera validation.

### Known W0 setup blocker

`package.json` currently runs:

```text
electron-rebuild && bash scripts/copy-ort-wasm.sh
```

That assumes `bash` is available. Git for Windows includes Git Bash, but Bash is
not guaranteed to be on a normal PowerShell `PATH`. The durable W0 fix is to
replace `scripts/copy-ort-wasm.sh` with a cross-platform Node script and call it
with `node`. Until that fix is committed, run `npm ci` from Git Bash or expose
Git's Bash executable on the current shell path. Do not omit the copy step,
because packaged runtime assets may otherwise be incomplete.

## 3. Clone and install

In PowerShell:

```powershell
git clone https://github.com/imperator28/bilingualmeetingcaption.git
Set-Location bilingualmeetingcaption
git switch codex/phase-0-phase-1
node --version
npm --version
npm ci
```

If the branch has already been merged, switch to `main`.

Expected Node major version: `20`.

## 4. Store the OpenAI API key safely

Preferred method:

1. Launch the app.
2. Open **Settings**.
3. Paste the key into **API key**.
4. Save it, then use **Test saved key**.

The packaged app writes an encrypted credential beneath Electron's Windows
`userData` directory. Electron `safeStorage` protects it with Windows DPAPI.
The current credential store decrypts once per app launch and caches the key in
memory.

Never place a real key in:

- a tracked `.env` file;
- source code, tests, screenshots, issue text, or session logs;
- `package.json`, Forge configuration, or a PowerShell profile;
- GitHub Actions workflow YAML; or
- a command copied into shared terminal history.

For local development only, the app can read `OPENAI_API_KEY` from the process
environment or `.env.local`. The UI-managed secure store is preferred. If
`.env.local` is temporarily used, verify it is ignored before adding a key:

```powershell
git check-ignore .env.local
```

The command must print `.env.local`. If it prints nothing, do not create the
file. Add the ignore rule first.

Use GitHub Actions **secrets** only for future signing or CI credentials. The
normal Windows build and tests must not require an OpenAI key.

### Windows-specific credential note

`electron/captions/credential-store.js` currently reports a macOS Keychain
message if decrypting a saved credential fails. W0 should replace it with a
platform-neutral message before Windows validation. This is a wording defect,
not a different storage mechanism.

## 5. Run the local checks

From PowerShell:

```powershell
npm run test:captions
npx vitest run
npm run build
```

The focused caption suite and production build are known to pass at this
handoff. The full `npx vitest run` command currently exposes inherited
repository test-configuration defects:

- Vitest collects three `node:test` `.cjs` files and reports that they contain
  no Vitest suite, even though `npm run test:captions` runs them correctly.
- Legacy sidecar/auth tests load `fzstd` and `electron-conf`, which are not
  declared by the current caption package.

W0 must separate the Vitest and Node test globs, then either declare the
dependencies needed by retained production code or exclude removed legacy
subsystems from the caption client. Do not hide a real dependency behind a
test-only mock. After that W0 cleanup, all three commands above must finish
with exit code 0.

Then start development mode:

```powershell
npm run dev
```

The repository's Vite Electron integration should launch the control window.
If it only opens a browser page, inspect the Vite terminal output and confirm
that the Electron entry was compiled and started.

## 6. First-run smoke test

Before using API credit:

1. Confirm the control window appears in the Windows taskbar.
2. Confirm the Session page scrolls at 100%, 125%, and 150% display scaling.
3. Open Settings and verify that the API-key status loads without repeated
   prompts.
4. Grant microphone access.
5. Select the intended microphone and confirm the level meter moves.
6. Switch stacked and side-by-side layout and confirm both the preview and
   native caption windows move.
7. Start and stop a demo session.
8. Close either caption window with its visible close button.
9. Use **Show captions** to restore both caption windows.

Do not advance to a live API test if any lifecycle control disappears or the
window alternates between ready and live.

## 7. Live Windows audio test

Use headphones and play a known English/Chinese recording through the normal
Windows playback device.

1. Start a live session.
2. Speak into the selected microphone.
3. Confirm the microphone meter and new `YOU` entries.
4. Play the test recording.
5. Confirm the meeting/system meter and new `MEETING` entries.
6. Confirm each finalized entry appears as English in the English surface and
   Simplified Chinese in the Chinese surface.
7. Stop the session with **Stop Session**.

If microphone works but meeting audio does not, debug the Windows loopback path
before translation. The app uses Electron display-media loopback; it does not
need a virtual audio cable.

## 8. Create an unsigned installer

Run on Windows:

```powershell
npm run make
```

Expected output directory:

```text
out\make\squirrel.windows\x64\
```

Expected artifacts include:

- a `Setup.exe`;
- a `.nupkg`; and
- a `RELEASES` file.

Install the setup executable on a clean Windows user profile. Unsigned builds
may trigger Windows warnings and are for internal validation only.

The app should handle Squirrel startup/update/uninstall arguments before
creating windows. Electron Forge recommends `electron-squirrel-startup`; the
current app must be checked and corrected in W0 if those events are not already
handled.

## 9. Useful diagnostics

Capture diagnostics without exposing credentials or transcript content:

```powershell
Get-ComputerInfo |
  Select-Object WindowsProductName, WindowsVersion, OsBuildNumber, OsArchitecture
Get-CimInstance Win32_SoundDevice |
  Select-Object Name, Status, Manufacturer
```

For an installer failure:

```powershell
$env:DEBUG = "electron-windows-installer*"
npm run make
Remove-Item Env:DEBUG
```

Do not attach the full Electron `userData` directory to an issue. It can contain
encrypted credentials, settings, evaluation data, or future pending recordings.

## 10. W0 exit criteria

W0 passes only when:

- `npm ci` succeeds in a normal documented Windows shell;
- both automated test commands and the production build pass after the
  documented W0 test-runner cleanup;
- development mode starts the Electron client;
- an unsigned Squirrel installer is created and installs;
- the installed control window starts and exits cleanly;
- no API key exists in Git history or build output; and
- the W0 section of the validation matrix is complete.
