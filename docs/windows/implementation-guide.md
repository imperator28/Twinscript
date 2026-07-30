# Windows implementation guide

This is the ordered engineering plan for reaching a Windows client that is
ready for real meetings, followed by virtual-camera output. Keep each gate
small enough to validate on a physical Windows machine.

## Architecture at handoff

The caption client is an Electron application with a React renderer.

```text
Microphone ── ModernAudioRecorder ─┐
                                  ├─ renderer PCM IPC ─ main process
Windows output ─ LoopbackRecorder ┘                       │
                                                         ├─ gpt-live-transcribe
                                                         │  per audio channel
                                                         ├─ transcript ordering /
                                                         │  duplicate suppression
                                                         ├─ EN/ZH normalization
                                                         └─ audience projections
                                                               │
                                      control log ◀────────────┤
                                      English overlay ◀────────┤
                                      Chinese overlay ◀────────┘
```

### Main process

- `electron/captions-main.js` creates the control and caption windows,
  initializes `electron-audio-loopback`, and wires stores and session services.
- `electron/captions/register-caption-ipc.js` is the trusted IPC boundary. It
  validates the sender for both request/response and high-volume audio traffic.
- `electron/captions/caption-session-manager.js` owns the session lifecycle,
  two transcription sessions, ordering, duplicate suppression, normalization,
  usage, and in-memory history.
- `electron/captions/live-transcription-session.js` owns one OpenAI
  transcription WebSocket and explicit audio-turn commits.
- `electron/captions/caption-window-manager.js` owns two always-on-top audience
  windows and layout.
- `electron/captions/settings-store.js` owns the allowlisted persisted settings.
- `electron/captions/credential-store.js` owns the encrypted OpenAI credential.
- `electron/captions/glossary-config.js` owns built-in/imported meeting
  configurations and their size limits.

### Preload and renderer

- `electron/captions-preload.js` exposes a narrow `window.captions` bridge.
- `src/captions/audioCapture.ts` captures microphone and system streams
  independently, converts both to 24 kHz mono PCM, and sends channel-tagged
  buffers over IPC.
- `src/lib/modern-audio/LoopbackRecorder.ts` uses the retained cross-platform
  loopback integration.
- `src/captions/ControlApp.tsx` is the operator interface.
- `src/captions/CaptionSurface.tsx` renders an audience-specific projection.
- `src/captions/captions.css` styles both control and audience surfaces.

The main process is the shared-state authority. Do not add direct
window-to-window communication or expose raw `ipcRenderer`.

## Work package W0 — reproducible Windows build

Goal: remove setup ambiguity and prove the package can be produced natively.

### Changes

1. Replace the Bash-only `scripts/copy-ort-wasm.sh` post-install dependency
   with a cross-platform Node script.
2. Add an early Squirrel startup handler if the application does not already
   consume install, update, and uninstall events.
3. Verify the platform-specific credential unlock message and scoped
   **Repair secure storage** action on a clean Windows user profile.
4. Set a Windows App User Model ID that matches the Squirrel package.
5. Confirm the packaged app includes `build/`, required WASM runtimes,
   `dist-electron/`, `assets/`, and `resources/`.
6. Make the Windows CI artifact available for validation builds, not only
   version tags. A pull-request or manually dispatched build should upload the
   unsigned setup artifact with short retention.
7. Remove or quarantine inherited extension/Linux release behavior from the
   Windows validation path. Do not require unrelated Sokuji products to pass
   the Windows caption gate.
8. Separate Vitest discovery from the `node:test` caption files. Resolve the
   retained legacy tests that currently require undeclared `fzstd` and
   `electron-conf` modules: declare a real runtime dependency when production
   code still uses it, otherwise remove that subsystem from this focused
   client and its test job.

### Tests

- Add a Node test for the cross-platform asset-copy script.
- Keep the unit coverage for platform-specific credential errors and scoped
  secure-storage repair behavior passing.
- Add a main-process test for Squirrel argument handling.
- Prove `npm run test:captions` and `npx vitest run` both have intentional,
  non-overlapping discovery and exit 0.
- Run the W0 manual install/uninstall checks.

### Exit

The full W0 criteria are in
[`validation-matrix.md`](validation-matrix.md#w0--build-package-and-install).

## Work package W1 — Windows meeting parity

Goal: run a real bilingual session using separate microphone and Windows
loopback audio.

### Audio capture

Keep the two input channels independent:

- `microphone` represents the local speaker;
- `system` represents the meeting playback.

The Windows loopback path should use Electron's display-media request handler
with `audio: 'loopback'`. Do not route through VB-CABLE. Discard any video track
immediately because the product is capturing sound, not the screen.

The start sequence must be:

1. validate the saved key;
2. open both transcription transports;
3. start microphone capture;
4. start system loopback capture;
5. transition once to `running`; and
6. preserve a visible **Stop Session** action during degraded/reconnecting
   states.

If loopback fails, continue microphone captions and show a persistent,
actionable warning. Never claim the meeting channel is live when its RMS and
sent-audio counters remain zero.

### Windows overlay behavior

Validate and correct:

- `alwaysOnTop` on Teams, Zoom, Chrome, Edge, PowerPoint, and a full-screen
  shared window;
- top drag handle and Windows resize hit regions;
- close button hides both overlays without stopping the session;
- control window remains present in the taskbar;
- stacked and side-by-side placement at 100%, 125%, and 150% scale;
- multi-monitor work areas and negative display coordinates; and
- taskbar position on any screen edge.

Keep caption windows out of the taskbar. Keep the control window in it.

### Bilingual correctness

Both audio channels use transcription sessions capable of English and
Simplified Chinese. For every finalized source entry:

- the English audience projection must contain English;
- the Chinese audience projection must contain Simplified Chinese;
- mixed-language and unknown-source entries must normalize both targets; and
- protected product terms such as `T1`, `EVT`, `DVT`, and `PVT` remain intact.

Do not use language detection to choose which audience receives an entry. Both
audiences receive every retained entry.

### Tests

- Unit tests for lifecycle states so reconnecting cannot remove the stop action.
- Loopback startup/failure tests with mocked media streams.
- Projection tests for English, Chinese, and inline code-switching.
- Manual two-person Teams or Zoom test on a physical Windows machine.

## Work package W2 — meeting records and visible history

Goal: implement the approved recording/history spec on both macOS and Windows
before camera work depends on it.

**Approval:** This work package was approved for implementation on 2026-07-30.
It is part of the core meeting client, not an optional recording extension.

The detailed behavior is normative in
[`../superpowers/specs/2026-07-30-meeting-records-visible-history-design.md`](../superpowers/specs/2026-07-30-meeting-records-visible-history-design.md).
The following is the recommended code decomposition.

### Delivery sequence

Implement W2 as three independently testable changes:

1. **W2a — record core**
   - settings migration;
   - transcript JSONL and atomic finalization;
   - installation key and per-chunk encryption;
   - separate microphone and meeting writers;
   - keep/discard and WAV finalization;
   - startup crash recovery.
2. **W2b — operator workflow**
   - meeting-record Settings card;
   - visible always-recording disclosure;
   - backup health states during the session;
   - post-meeting Keep/Discard review;
   - pending-decision recovery after restart;
   - explicitly labelled session log and exports.
3. **W2c — audience history and prompt budget**
   - replace caption pace with 3–10 complete entries;
   - bottom-anchored upward overlay growth;
   - age-based opacity and reduced motion;
   - 16-row/800-character per-utterance glossary context;
   - Windows and macOS integration/soak validation.

W2 passes only when all three slices pass. W3 may use the W2 history component,
but camera work must not begin by bypassing failed recording or recovery tests.

### New main-process modules

Create focused modules under `electron/captions/`:

- `meeting-record-store.js`
  - creates the session directory and manifest;
  - appends finalized transcript JSONL;
  - atomically finalizes `transcript.json`, `transcript.md`, and
    `session.json`;
  - enumerates records and pending retention decisions.
- `recording-key-store.js`
  - creates one installation key;
  - protects it through asynchronous Electron `safeStorage`;
  - caches it for the app launch;
  - never performs one DPAPI operation per audio chunk.
- `encrypted-audio-writer.js`
  - owns one bounded write queue per channel;
  - encrypts each PCM record with AES-256-GCM before disk;
  - writes only app-owned `.bcr` chunk streams;
  - reports degraded and failed backup states without interrupting
    transcription.
- `wav-finalizer.js`
  - validates the authenticated chunk stream;
  - writes a temporary WAV;
  - flushes and atomically renames it;
  - handles a missing channel explicitly.
- `meeting-record-controller.js`
  - coordinates start, crash recovery, stop, keep, discard, reveal, and export.

### Existing integration points

1. Construct the record controller in `electron/captions-main.js`.
2. Pass it through `registerCaptionIpc`.
3. In the `captions:audio` handler, copy the validated PCM into two independent
   sinks:
   - live transcription; and
   - the matching encrypted backup writer.
4. In `CaptionSessionManager.releaseFinalTranscript`, emit a finalized caption
   record to the record controller. Do not write every provisional revision.
5. On `session-stop`, stop capture first, flush both writers, finalize the
   transcript, and return the post-meeting decision state.
6. Add narrow IPC methods for status, records directory, keep, discard,
   export, and reveal. Validate sender and payload for every method.
7. Add the post-meeting review to `ControlApp.tsx`.

### Settings migration

Increment `settingsVersion` and replace `captionPaceMs` with:

```json
{
  "autoSaveTranscript": true,
  "keepAudioAutomatically": false,
  "meetingRecordsDirectory": null,
  "captionHistoryEntries": 6
}
```

Clamp `captionHistoryEntries` to the inclusive range 3–10. A legacy
`captionPaceMs` value is discarded rather than reinterpreted.

### Visible history rendering

In `CaptionSurface.tsx`:

- remove the fixed `MAX_VISIBLE_LINES = 3`;
- read `captionHistoryEntries` from settings;
- retain the newest 3–10 complete entries plus the current provisional entry;
- revise an existing entry in place by ID;
- assign opacity by entry age, not by a timer;
- keep older retained entries readable;
- animate only vertical reflow and entry/exit;
- honor `prefers-reduced-motion`.

In `CaptionWindowManager`:

- remove `CaptionPresentationPacer` and `captionPaceMs`;
- calculate the target height from the rendered content;
- accept a clamped height request from each trusted caption window;
- keep the lower edge fixed and move `y` upward as height increases;
- keep both windows within their current display work area; and
- reapply stacked or side-by-side layout after a monitor/DPI change.

Use a renderer measurement such as `ResizeObserver`, but send only a numeric
height through validated IPC. The main process remains responsible for native
window bounds.

### Session-log semantics

Each row must label:

- speaker: `YOU` or `MEETING`;
- original text and detected source language;
- English audience text; and
- Chinese audience text.

Do not present two unlabeled columns. Passthrough text is still an audience
projection and should be marked as such.

### Per-utterance glossary budget

The built-in/imported configurations may remain comprehensive on disk, but the
normalizer must not receive the full active glossary on every utterance.

Add a pure request-context compiler, either in `glossary-config.js` or a focused
`glossary-request-context.js`, which:

1. matches custom terms, built-in terms, Chinese aliases, and regional aliases
   against the source text;
2. puts matched custom terms first;
3. puts matched built-in terms next;
4. uses high-priority configuration terms only for remaining capacity;
5. includes only protected tokens detected in the current source;
6. stops at 16 bilingual rows or 800 terminology characters, whichever occurs
   first; and
7. reports row count and prompt-character count in usage metrics.

Call it before every `OpenAINormalizer.normalize` request in
`CaptionSessionManager`; pass the reduced context instead of
`this.settings.glossary` and the complete protected-token list. Keep the
transcription session's one-time keyword list separate and provider-bounded.

Unit-test English, Chinese, regional-alias, case-insensitive token, custom
override, and exact-boundary cases. Prompt caching may reduce billing but must
not be required for this bound to work.

## Work package W3 — OBS virtual-camera validation

Goal: prove the meeting experience before funding native camera integration.

Implement the 16:9 bilingual camera stage described in
[`virtual-camera.md`](virtual-camera.md). The stage is a dedicated renderer
surface driven by the same main-process caption state as the overlays.

The user-facing output selector should have:

- **On-screen captions**; and
- **Virtual camera**.

For W3, selecting **Virtual camera** opens the stage and an instruction state
for OBS. It must not pretend that a native camera has started.

Do not bundle, redistribute, automate, or modify OBS in this gate. A manual OBS
installation is acceptable for private validation.

## Work package W4 — native Windows 11 camera

Goal: replace OBS for supported Windows 11 systems without changing caption
semantics or stage design.

Recommended boundary:

```text
Electron main
  ├─ audience state hub
  ├─ camera lifecycle IPC
  └─ native-camera companion supervisor
          │ named pipe + shared-memory frame buffer
          ▼
Signed x64 C++ companion
  ├─ Media Foundation media source
  ├─ IMFVirtualCamera registration/lifecycle
  └─ frame clock and format conversion
```

Use a separate companion process rather than an in-process Node native addon:

- a camera crash cannot take down the caption session;
- Electron upgrades do not require rebuilding an N-API module loaded into the
  main process;
- native logs and lifecycle are isolated;
- Windows version/architecture checks are straightforward; and
- signing and installer ownership are clearer.

The stage renderer should produce deterministic 1920×1080 BGRA frames at
15 or 30 fps. The companion converts only if the meeting client requests a
supported alternate format. Do not build a general video engine.

Use `MFCreateVirtualCamera`/`IMFVirtualCamera` only on Windows Build 22000 or
newer. On unsupported Windows versions, present OBS as the available camera
route.

Required lifecycle:

1. install/register the camera during an explicit app action or installer step;
2. start the native source;
3. publish frames only while the camera mode is active;
4. stop cleanly when the user switches to overlays or exits;
5. recover from a companion crash without stopping transcription; and
6. remove/unregister cleanly on uninstall.

Do not start W4 until W3 passes a 60-minute real-meeting soak.

## Work package W5 — release engineering

### Signing

The current `.github/workflows/build.yml` has:

```text
github.repository == 'kizuna-ai-lab/sokuji'
```

on the Windows signing job. Consequently, tagged builds in
`imperator28/bilingualmeetingcaption` cannot produce the signed artifact
expected by the release job.

Before the first release:

1. choose a Windows code-signing provider;
2. configure its IDs as GitHub Actions variables and its token/certificate
   material as GitHub Actions secrets;
3. change the repository gate;
4. make release dependencies tolerate an explicitly unsigned internal build,
   or require signing and fail with a clear message;
5. sign the installer, app executable, native-camera companion, and any
   registration component; and
6. verify signatures before publishing.

The earlier SignPath documents under `docs/superpowers/` are background
material, not current configuration for this repository.

### CI

Create focused jobs:

- `test` — platform-independent unit/component tests;
- `windows-build` — Windows x64 build and unsigned artifact;
- `windows-smoke` — packaged app launch/exit smoke test;
- `windows-sign` — protected release environment only; and
- `windows-release` — signature verification and release asset assembly.

Do not couple Windows caption releases to the upstream browser extension,
Linux packages, or macOS packaging.

## Pull-request boundaries

Keep work reviewable even for a single developer:

1. W0 build portability and Windows packaging.
2. W1 Windows audio and overlay corrections.
3. W2a meeting-record core and tests.
4. W2b post-meeting UI and visible history.
5. W3 camera stage and OBS documentation.
6. W4 native companion proof of concept.
7. W4 native camera production integration.
8. W5 signing and release workflow.

Do not combine W0–W4 in one change. A failed Windows audio session should not
require debugging encryption, dynamic overlays, and a camera driver at once.

## Definition of “ready for actual validation”

The Windows client is ready for the owner's judgment call at the end of W3,
when:

- a packaged Windows 11 x64 app completes a 60-minute bilingual meeting;
- both microphone and meeting audio produce correctly attributed captions;
- both audience languages remain correct through code-switching;
- the user can stop, hide, restore, drag, and resize the app without jitter;
- transcript recovery and the audio keep/discard decision work after restart;
- 3–10 complete entries remain visible and the overlay grows upward;
- the half-English/half-Chinese stage is readable as OBS Virtual Camera in the
  selected meeting client; and
- cost, dropped-audio, reconnect, and translation-failure evidence is saved
  without recording the API key.

Native camera work is a distribution improvement after this point, not a
prerequisite for judging the core meeting experience.
