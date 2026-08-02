# W2 working-tree automated evidence

Date: 2026-07-30  
Platform: Windows 11 x64, native PowerShell environment  
Branch: `codex/phase-0-phase-1`  
State: uncommitted working tree containing the earlier W0/W1 changes and W2

## Automated results

The final verification commands for this working tree are:

```powershell
npm.cmd run test:captions
npx.cmd vitest run --maxWorkers=1
npm.cmd run build
npm.cmd run make
```

Results captured after W2 implementation:

- main-process caption tests: 162 passed, 0 failed;
- renderer/shared Vitest: 149 files and 1,670 tests passed, 0 failed;
- Vite production build: exits 0 and emits the W2 record, glossary-context,
  overlay-layout, controller, IPC, and preload modules under `dist-electron/`;
- Electron Forge make: exits 0 and creates:
  - `Bilingual Meeting Captions-0.1.0 Setup.exe` (140,339,200 bytes);
  - `BilingualMeetingCaptions-0.1.0-full.nupkg` (139,399,916 bytes);
  - `RELEASES` (95 bytes).

The first make attempt was blocked by sandbox network policy while Forge tried
to download Electron. The approved network-enabled rerun completed. This is an
environment restriction, not an application failure.

An initial parallel Vitest verification ended with one unexpected worker
process exit after 1,656 passing assertions and no assertion failure. The
unchanged suite then passed completely with one worker, isolating that result
to runner concurrency/resource pressure rather than W2 behavior.

## W2 behaviors covered by automated tests

- settings migration to transcript auto-save on, automatic audio retention
  off, and six visible entries;
- transcript-off mode still creates encrypted temporary audio while omitting
  transcript files;
- append-only final-caption JSONL and crash-truncated-line recovery;
- atomic JSON, Markdown, and session-manifest finalization;
- installation-key caching and zeroing;
- authenticated independent microphone and meeting chunk streams;
- bounded backup queues and visible degraded/failed states;
- aligned WAV generation, missing/failed channel handling, idempotent Keep and
  Discard, and restart recovery;
- trusted-sender, named meeting-record IPC with no arbitrary renderer paths;
- post-meeting and recovered-decision renderer flows;
- labelled original, English-view, and Chinese-view session rows;
- immediate 3–10 complete-entry history plus every in-flight row;
- aggregate bilingual completion, with every in-flight row and the two newest
  settled rows remaining prominent in both panels;
- fresh-session clearing plus rejection of late prior-session caption events;
- equal-height bottom-anchored stacked/side-by-side geometry with 45%/33%
  balanced work-area caps;
- shared automatic sizing from natural inner content, generation guards,
  direct synchronized manual resizing, and persisted manual height;
- four validated paired caption themes with Blueprint as the default and
  matching native window backgrounds;
- 16-row/800-character utterance glossary selection and metrics; and
- production bundling of every W2 main-process module.

## Owner approval script

Use synthetic or consent-safe speech and do not commit raw audio or a real
transcript.

1. Install or launch the packaged x64 build on Windows 11.
2. Start a live session with a microphone and meeting/system playback active.
3. Confirm the persistent backup state reads microphone + meeting and that
   both caption channels continue normally.
4. Force-terminate once, relaunch, and confirm the recovered meeting blocks a
   new live session until Keep or Discard is chosen.
5. Keep one meeting. Play `microphone.wav` and `meeting-audio.wav`, confirm
   channel attribution and alignment, and inspect `session.json`.
6. Discard a second meeting. Confirm no `.bcr`, PCM, or WAV remains for it and
   that the manifest records `discarded`.
7. Repeat with meeting/system capture unavailable and confirm microphone-only
   retention plus an explicit missing-system state.
8. While one translation lags, confirm all in-flight rows and the two newest
   settled rows stay full-size/full-opacity in both panels.
9. Resize English, then Chinese. Confirm the peer follows live, captions do
   not snap the height back, and the chosen height survives app restart.
10. Set visible history to 3 and 10. Confirm sizing returns to automatic,
    panels remain equal, and check stacked/side-by-side overlays at 100%, 125%,
    and 150% scaling and on a secondary monitor.
11. Stop and start a session. Confirm both overlays start empty while the
    previous meeting record remains available.
12. Select Blue Air, Blueprint, Steel, and Telemetry. Confirm each pair is
    distinct/readable over bright and dark applications and persists restart.
13. Inspect the live log and saved JSON/Markdown for `YOU`/`MEETING`, original
   language, English view, and Chinese view labels.
14. Run a consent-safe soak and record redacted observations in a new evidence
    report.

## Not yet proven

- real Windows loopback encryption throughput and backpressure behavior;
- audible alignment and playback of retained real-device WAVs;
- forced process/OS termination with actual audio in flight;
- filesystem deletion behavior under antivirus/indexer contention;
- installed-app dialogs, Explorer reveal, and DPAPI recovery on a clean profile;
- macOS Keychain, Finder, overlay, and retained-audio parity;
- accessibility and visual quality at all required DPI/multi-monitor layouts;
- real pointer feel and persistence for synchronized resizing;
- real translation-lag focus behavior and all four theme pairs over varied apps;
- 60-minute cost, memory, queue-depth, and reliability evidence.

W2 remains open until the owner records those observations in the validation
matrix.
