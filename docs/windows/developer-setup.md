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
2. Node.js 20 LTS. The repository's GitHub Actions workflows also use Node 20.
   Node 24 has been verified locally for `npm ci`, both test commands, the
   production build, and `electron-forge make`; CI remains the Node-20 record.
3. Visual Studio 2022 Build Tools with:
   - **Desktop development with C++**;
   - MSVC v143 x64/x86 build tools; and
   - a current Windows 11 SDK.
4. PowerShell 7 is recommended but not required.

Do not install VB-CABLE. It belongs to retained Sokuji voice-routing code and is
not part of this subtitle or camera validation.

### Resolved W0 setup blocker

`postinstall` previously ran `bash scripts/copy-ort-wasm.sh`, which fails in a
normal PowerShell session because Git Bash is not guaranteed to be on `PATH`.
It now runs:

```text
electron-rebuild && node scripts/copy-ort-wasm.cjs
```

`scripts/copy-ort-wasm.cjs` is the cross-platform port and is covered by
`electron/captions/copy-ort-wasm.test.cjs`. `npm ci` needs no shell beyond
PowerShell or cmd.exe. Never skip the copy step with `--ignore-scripts`; the
GTCRN noise-suppression worker loads its ONNX Runtime from `public/wasm/ort/`.

The copy writes those files with LF. A Windows checkout with
`core.autocrlf=true` used to convert the `.mjs`/`.js` ones to CRLF, so every
`npm ci` left four tracked files reported as modified with an empty diff.
`.gitattributes` now marks `public/wasm/**` as `-text`. If you cloned before that
existed and still see the phantom modifications, run once:

```powershell
git add --renormalize public/wasm/ort/
```

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

`electron/captions/credential-store.js` now reports a platform-specific secure
storage message if decrypting a saved credential fails. The Settings recovery
action removes only the app's encrypted OpenAI credential on Windows; it does
not alter meeting records, glossaries, or preferences.

## 5. Run the local checks

From PowerShell:

```powershell
npm run test:captions
npx vitest run
npm run build
```

All three commands exit 0 on Windows. The two test runners have deliberately
non-overlapping discovery:

- `npm run test:captions` runs `node --test electron/captions/*.test.cjs` — the
  main-process caption suites.
- `npx vitest run` runs `src/**/*.test.{ts,tsx}` and `electron/**/*.test.js`.

`vitest.config.ts` pins both globs. `electron/better-auth-adapter.test.js` and
`electron/sidecar-bundle.test.js` are excluded: they test main-process
subsystems reachable only from `electron/main.js`, which is not a build entry in
`vite.config.ts` and never ships in `dist-electron/`, and they require `fzstd`
and `electron-conf`, which this client does not depend on. They are quarantined,
not mocked — see the follow-up list in
[`implementation-guide.md`](implementation-guide.md#known-follow-ups).
`extension/` is likewise out of the caption gate; it is the upstream browser
extension and this client neither builds nor ships it.

`electron/captions/test-discovery.test.cjs` fails if either glob drifts back
into the other's files.

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
6. Reveal the caption windows with **Show captions** or `Ctrl+Shift+C`. They are
   created hidden and are otherwise revealed by starting a session, so an empty
   screen before this step is expected, not a failure.
7. Switch stacked and side-by-side layout and confirm both the preview and
   native caption windows move.
8. Start and stop a demo session.
9. Close either caption window with its visible close button.
10. Use **Show captions** to restore both caption windows.
11. Close the control window and confirm the app exits: no
    `bilingual-meeting-captions` process should remain.

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

Squirrel arguments are handled by `electron/captions/squirrel-startup.js`, which
`electron/captions-main.js` calls before `initMain()` and before any window is
created. It creates shortcuts on `--squirrel-install`/`--squirrel-updated`,
removes them on `--squirrel-uninstall`, exits on `--squirrel-obsolete`, and
treats `--squirrel-firstrun` as an ordinary launch. It also sets the
AppUserModelID `com.squirrel.BilingualMeetingCaptions.bilingual-meeting-captions`
so Windows groups the taskbar entry with the shortcut Squirrel installed. A test
asserts that value still matches the Forge maker configuration.

If you need a build made by CI instead, run the **Windows caption client**
workflow (`.github/workflows/windows-ci.yml`) and download the
`windows-x64-unsigned-<sha>` artifact. It is retained for 14 days.

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
