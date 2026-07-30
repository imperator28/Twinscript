# Windows client handoff

**Last verified:** 2026-07-30  
**Repository:** `imperator28/bilingualmeetingcaption`  
**Primary target:** Windows 11 22H2 or newer, x64  
**Current branch at handoff:** `codex/phase-0-phase-1`

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
| Separate microphone and meeting-audio capture | Implemented, Windows unvalidated | The renderer creates separate 24 kHz PCM streams. Windows loopback must be tested on real hardware. |
| `gpt-live-transcribe` bilingual transcription | Implemented | Each audio channel owns a transcription WebSocket. |
| English and Chinese audience normalization | Implemented | Every finalized caption is projected into both audience languages. |
| Stacked and side-by-side overlays | Implemented | Native caption windows exist; Windows placement and taskbar behavior remain unvalidated. |
| Built-in and imported engineering glossaries | Implemented | The current configuration bounds the active glossary. |
| Per-utterance glossary request budget | Designed, not implemented | Enforce the approved maximum of 16 matched rows and 800 prompt characters before W2 passes. |
| Focused meeting UI and Advanced Validation area | Implemented | Evaluation controls are outside the normal meeting flow. |
| Squirrel.Windows installer configuration | Implemented, unsigned | `electron-forge make` is configured for x64 Windows. |
| Windows CI build | Configured, needs repository validation | The matrix includes `windows-latest`. Tag-only artifact behavior and inherited upstream settings need cleanup. |
| Always-on encrypted temporary dual-track recording | Designed, not implemented | Follow the approved meeting-record spec. |
| Transcript auto-save and post-meeting keep/discard | Designed, not implemented | Follow the approved meeting-record spec. |
| Visible history of 3–10 complete captions | Designed, not implemented | The current UI still uses a fixed three-line view and time pacing. |
| Full-screen half-English/half-Chinese camera stage | Designed in this handoff, not implemented | Build before OBS validation. |
| OBS virtual-camera output | Validation path selected, not integrated | OBS is the first camera path on Windows and does not require app code signing. |
| Native Windows virtual camera | Not implemented | Build only after the Windows app and OBS path pass their gates. |
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
- Windows 11 x64 is the first Windows target.
- OBS is the first virtual-camera validation route. A native Windows 11 camera
  follows only after the meeting client is stable.
- Windows 10 may use the app with OBS, but is not a native-camera target.
- VB-CABLE is not required for this subtitle-only client or the OBS camera
  path. Legacy Sokuji virtual-microphone code is out of scope.

## Gate summary

| Gate | Outcome |
| --- | --- |
| W0 — Native build | A clean Windows 11 x64 machine can install dependencies, run tests, launch development mode, and create an unsigned installer. |
| W1 — Meeting parity | Microphone, Windows loopback, bilingual captions, overlays, and session lifecycle work in a real meeting. |
| W2 — Records and history | The approved transcript, encrypted dual-track backup, post-meeting decision, and 3–10-entry history behavior work on Windows and macOS. W2 is required before W3. |
| W3 — OBS camera | A 16:9 bilingual stage can be captured by OBS and selected as a camera in a meeting app for 60 minutes. |
| W4 — Native camera | A Windows 11 native virtual camera exposes the same stage without OBS. |
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
