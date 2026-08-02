# Twinscript 会意 — Windows client handoff

> **Renamed 2026-08-02.** The product was "Bilingual Meeting Captions"; it is now
> **Twinscript** (Chinese name **会意**, huìyì — "to grasp the meaning", and also
> 会意字, one of the classical categories of Chinese character formation).
> Consequences of the rename are recorded in
> [`rename-2026-08-02.md`](rename-2026-08-02.md).

**Last verified:** 2026-08-01 (W4 production implementation automated checks
verified on Windows 11 build 26200 x64; manual validation remains — see
[evidence](evidence/2026-08-01-w4-production/README.md))
**Repository:** `imperator28/bilingualmeetingcaption`  
**Primary target:** Windows 11 22H2 or newer, x64  
**Current branch:** `codex/phase-0-phase-1`

This folder is the source of truth for continuing the app on Windows. It is
written for one developer working on a private in-house client, so the gates
focus on executable evidence rather than approval ceremony.

## Read in this order

1. [Developer setup](developer-setup.md) — prepare a clean Windows machine,
   run the app, and create an unsigned installer.
2. [Implementation guide](implementation-guide.md) — current architecture,
   known gaps, file-level work packages, and the order in which to build them.
3. [Validation matrix](validation-matrix.md) — repeatable Windows tests and
   evidence required to advance each gate.
4. [Virtual camera](virtual-camera.md) — OBS-first validation followed by the
   Windows 11 native camera architecture.

The approved cross-platform recording and visible-history behavior is defined
in
[`../superpowers/specs/2026-07-30-meeting-records-visible-history-design.md`](../superpowers/specs/2026-07-30-meeting-records-visible-history-design.md).
The broader product definition and earlier decisions remain under
`docs/superpowers/specs/` and `docs/superpowers/plans/`.

## Status at handoff

| Capability | Status | Meaning |
| --- | --- | --- |
| Electron/React control client | Implemented on macOS | The current product UI and session controls exist. |
| Separate microphone and meeting-audio capture | Implemented, Windows unvalidated | The renderer creates separate 24 kHz PCM streams. A failed loopback now keeps microphone captions running behind a persistent, platform-correct warning, and no channel reports `LIVE` until its transport counter or RMS moves. Windows loopback must still be tested on real hardware. |
| `gpt-live-transcribe` bilingual transcription | Implemented | Each audio channel owns a transcription WebSocket. |
| English and Chinese audience normalization | Implemented | Every finalized caption is projected into both audience languages. |
| Stacked and side-by-side overlays | Implemented, owner validation pending | Native caption windows use equal shared height, bottom anchoring, and work-area-aware 45% stacked/33% side-by-side caps. Resizing either panel synchronizes the peer and persists until Visible history returns sizing to automatic mode. Real `alwaysOnTop`, direct resize feel, DPI, and taskbar behavior still require operator testing. |
| Universal and imported engineering glossaries | Implemented, owner validation pending | One 138-term built-in engineering glossary covers mechanical design, manufacturing, quality, tooling, and South China supplier language. Custom imports and protected tokens remain available, while each request stays bounded. |
| Per-utterance glossary request budget | Implemented, live usage unvalidated | The pure request-context compiler prioritizes matched custom/built-in/alias rows, includes only detected protected tokens, and enforces 16 rows/800 prompt characters with per-request metrics. Live cost evidence remains an owner check. |
| Focused meeting UI and Advanced Validation area | Implemented | Evaluation controls are outside the normal meeting flow. |
| Squirrel.Windows installer configuration | Implemented, unsigned | `electron-forge make` produces `Setup.exe`, `.nupkg`, and `RELEASES` for x64 on a real Windows machine. Squirrel install/update/uninstall arguments and the AppUserModelID are handled and unit-covered. Installing on a clean profile is still unrun. |
| Native Windows build from a clean checkout | Verified | `npm ci`, `npm run test:captions`, `npx vitest run`, `npm run build`, `npm run dev`, and `npm run make` all exit 0 in plain PowerShell. The Bash-only postinstall and the overlapping test globs are fixed. |
| Windows CI build | Implemented | `.github/workflows/windows-ci.yml` runs both test suites and uploads an unsigned x64 installer on every branch, pull request, and manual run, with 14-day retention. It depends on no extension, Linux, or macOS job. |
| Always-on encrypted temporary dual-track recording | Implemented, hardware validation pending | Live PCM is teed after transcription into bounded, independently authenticated microphone/system streams. Packaging and unit recovery/retention tests pass; real dual-channel disk and playback evidence is still required. |
| Transcript auto-save and post-meeting keep/discard | Implemented, owner validation pending | Final captions append to crash-safe JSONL, stop/recovery produce JSON/Markdown/session manifests, and the named preload workflow exposes Keep, explicit Discard, copy, reveal, and restart recovery. |
| Focused visible history of 3–10 complete captions | Implemented, visual validation pending | Every in-flight caption and the two newest aggregate-settled captions remain full-size/full-opacity in both audience panels. Older settled rows remain readable history; natural inner content drives one generation-guarded shared automatic height. |
| Fresh sessions and paired caption themes | Implemented, visual validation pending | Every new session clears both overlays while saved records remain available. Blueprint is the unchanged default; Graphite and Red / Blue provide distinctly grey and blue/red paired options. Removed theme IDs migrate to Blueprint. |
| Full-screen half-English/half-Chinese camera stage | Implemented, meeting-client validation pending | A secure, fixed-16:9 1920×1080 stage renders paired complete entries, shared 3–10 history, 5% safe areas, and a privacy slate outside live sessions. Automated tests, production build/package, and a synthetic 1280×720 visual pass succeeded on 2026-07-30. |
| OBS virtual-camera output | Installed and registered; meeting validation in progress | The persisted output selector opens the dedicated stage and switches back to overlays without stopping a session. Official OBS 32.1.2 is installed, its 32-bit and 64-bit virtual-camera modules are registered, authenticated `StartVirtualCam` succeeds, and Chrome lists `OBS Virtual Camera` with a 1920×1080/30 fps track. A fresh native stage capture, meeting-app rendering, remote readability, and the 60-minute soak remain W3 requirements. |
| Native Windows virtual camera | Implementation complete; manual validation pending | The prior `MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED` defect is corrected. Electron now renders a never-shown 1920×1080 offscreen stage, publishes bounded BGRA frames through the versioned double-buffered ProgramData runtime region, and supervises a separate `IMFVirtualCamera` companion over a health-only named pipe. The source negotiates paced 15 fps NV12/RGB32, repeats a current frame for two seconds, then substitutes a neutral slate. Administrator-owned binaries, package-drift repair detection, COM lifetime accounting, serialized lifecycle/recovery, Windows 11 x64 gating, Squirrel cleanup, packaging, full-size Node→C++ transport, and fresh-build 20-frame delivery are automated and green. UAC installation, a newly registered separate consumer, Teams/Zoom/Chromium, standard-user lifecycle, and the 60-minute soak remain manual. See [`evidence/2026-08-01-w4-production/README.md`](evidence/2026-08-01-w4-production/README.md). |
| Signed Windows installer | Not configured for this repository | The existing SignPath job is restricted to `kizuna-ai-lab/sokuji`. |

## Decisions already made

- Do not rebuild the application from scratch.
- Ship subtitles only; do not generate translated speech.
- Both audience surfaces show the entire meeting in their own language.
- Microphone and meeting/system audio remain separate from capture through
  retained backup files.
- Transcript auto-save defaults to on.
- Temporary encrypted audio capture is always active in a real session. Audio
  retention defaults to off and is decided after the meeting.
- Meeting records are an approved W2 requirement and must pass before the OBS
  virtual-camera gate begins.
- Visible history means 3–10 **complete caption entries**, default 6. It does
  not mean delayed transcription.
- The overlay grows upward while its lower edge remains anchored.
- Both overlay panels always share one height. Stacked mode caps the pair at
  45% of the work area; side-by-side mode caps panel height at 33%.
- All in-flight rows and the two newest completed rows remain visually focused.
- Start Session always creates a visually fresh overlay; prior records remain
  saved.
- Blueprint is the default paired caption theme.
- The built-in glossary is always the universal engineering catalog; there is
  no meeting-type selector. Custom terms remain optional overrides.
- Caption themes are Blueprint, Graphite, and Red / Blue. In Red / Blue,
  English is blue and Chinese is red.
- The audience output selector offers On-screen captions and Virtual camera.
  Virtual-camera mode opens the dedicated stage and hides lower thirds; the
  user can switch back without ending the caption session.
- Windows 11 x64 is the first Windows target.
- OBS is the first virtual-camera validation route. A native Windows 11 camera
  follows only after the meeting client is stable.
- Windows 10 may use the app with OBS, but is not a native-camera target.
- VB-CABLE is not required for this subtitle-only client or the OBS camera
  path. Legacy Sokuji virtual-microphone code is out of scope.

## Gate summary

| Gate | Outcome |
| --- | --- |
| W0 — Native build | A clean Windows 11 x64 machine can install dependencies, run tests, launch development mode, and create an unsigned installer. **Verified 2026-07-30 through install, launch, clean exit, and uninstall. Three human checks remain: a visual taskbar confirmation, the API-key round trip, and the secure-storage recovery action.** |
| W1 — Meeting parity | Microphone, Windows loopback, bilingual captions, overlays, and session lifecycle work in a real meeting. **Code and unit coverage for degraded capture, channel liveness, lifecycle controls, and overlay geometry landed 2026-07-30. The gate itself needs the real two-person meeting on Windows hardware.** |
| W2 — Records and history | The approved transcript, encrypted dual-track backup, post-meeting decision, focused 3–10-entry history, synchronized sizing, fresh-session boundary, paired themes, and glossary-budget code is implemented and passes the automated Windows build/package gate. **W2 has not passed yet:** the owner must complete the real audio, translation-lag focus, resize persistence, crash-recovery, Keep/Discard playback, theme, DPI/multi-monitor, and cross-platform checks in the validation matrix. |
| W3 — OBS camera | A 16:9 bilingual stage can be captured by OBS and selected as a camera in a meeting app for 60 minutes. |
| W4 — Native camera | A Windows 11 native virtual camera exposes the same stage without OBS. **Implementation complete; pending user manual validation, so the gate is not passed.** The streaming defect and packaging decision are closed in code: compliant source activation, mapped frame delivery, offscreen compositor, companion supervision, explicit one-time elevated installation, repair/removal, and packaged resources all have automated evidence. Remaining checks require user approval or real meeting clients: approve the UAC install, run the installed separate consumer, validate Teams/Zoom/Chromium, exercise install/update/repair/remove as a standard user, confirm crash recovery during live transcription, and complete the 60-minute soak. W2 and W3 remain independently unpassed. |
| W5 — Release | A signed installer passes installation, update, uninstall, SmartScreen, and 60-minute soak checks. |

Advance a gate only when its evidence in
[the validation matrix](validation-matrix.md) is captured. A build or unit test
alone is not evidence that Windows audio or virtual-camera behavior works.

## Authoritative platform references

- [Electron `safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage)
  documents DPAPI-backed protection on Windows and recommends the asynchronous
  API.
- [Electron `session.setDisplayMediaRequestHandler`](https://www.electronjs.org/docs/latest/api/session)
  documents Windows loopback capture.
- [Electron Forge Squirrel.Windows](https://www.electronforge.io/config/makers/squirrel.windows)
  documents the installer output and Windows build requirement.
- [OBS Virtual Camera Guide](https://obsproject.com/kb/virtual-camera-guide)
  documents exposing an OBS scene as a webcam feed.
- [Microsoft `IMFVirtualCamera`](https://learn.microsoft.com/en-us/windows/win32/api/mfvirtualcamera/nn-mfvirtualcamera-imfvirtualcamera)
  documents the native Windows API and its minimum supported client,
  Windows Build 22000.
