# W4 Native Windows Camera Production Design

**Status:** Approved for implementation by the owner's 2026-08-01 instruction to continue until W4 is complete and awaiting manual validation.

## Goal

Make the existing Windows 11 virtual camera consume the private bilingual camera stage reliably, recover from one companion failure, install and remove predictably, and satisfy every W4 gate that can be proven without Teams, Zoom, Chromium, a standard-user install, or a real 60-minute operator soak.

## Boundaries

- Windows 11 build 22000 or newer, x64 only.
- Keep the existing 1920×1080, 15 fps, BGRA8 stage contract.
- Keep transcription and caption state authoritative in Electron.
- Keep the Media Foundation source and camera lifecycle out of process.
- Do not add translated speech, virtual microphones, DirectShow, 4K, Windows on Arm, or Windows 10 native-camera support.

## Architecture

Electron's `CaptionWindowManager` owns two camera-stage surfaces with identical caption state. The existing frameless `BrowserWindow` remains the optional Preview/Hide preview window. A second, never-shown 1920×1080 `BrowserWindow` uses Electron offscreen rendering at 15 fps and publishes its `paint` frames through a focused `CameraFramePublisher`. The publisher converts the returned `NativeImage` to a 1920×1080 bitmap when necessary and publishes double-buffered BGRA frames into a preallocated region file under the app's native-camera runtime directory. Hiding the preview therefore cannot stop the camera feed.

The region file uses the existing versioned `FrameHeader` and two frame slots. It is a Windows memory-mapped file on the native side and a positioned, asynchronous file writer on the Node side. The elevated one-time installation action creates its parent directory under ProgramData with write access for the installing user and read access for LocalService; the region is deleted or reset when the app stops. Frames never traverse Electron IPC, JSON, or the health pipe. Header publication remains sequence-last, and no write queue may retain more than one unpublished frame.

The `vcam-host` companion owns `MFCreateVirtualCamera`, camera start/stop, a local named-pipe health protocol, and one process lifetime. The COM media source opens the region read-only. For each requested sample it uses the latest coherent frame, repeats that frame for at most two seconds, then renders an explicit neutral slate. Sample timestamps use the Media Foundation system/QPC timebase and advance monotonically at the negotiated rate.

Electron's `NativeCameraSupervisor` starts the companion only when native-camera output is selected, consumes newline-delimited health messages, exposes one state snapshot to the control UI, and restarts the child once after an unexpected exit. It never stops transcription. A second failure becomes a visible manual-retry state and preserves the OBS fallback.

## Media Foundation compliance

The source must follow Microsoft's Frame Server custom-media-source contract:

- first and only stream ID is `0`;
- all activation attributes copy into source attributes;
- activation `ShutdownObject` and `DetachObject` return `E_NOTIMPL`;
- samples use `MFGetSystemTime()`-based timestamps;
- known uncompressed formats use two-dimensional media buffers;
- registration is machine-wide because Frame Server runs outside the user's HKCU context;
- the stable camera identity and CLSID do not change between installs.

## Runtime and failure behavior

- Unsupported Windows: native mode is unavailable and the UI explains that OBS remains available.
- Region absent or invalid: source produces the neutral slate and logs only protocol/health metadata.
- Writer idle/stopped: source produces the privacy slate, never stale transcript text.
- Writer stalls: repeat for two seconds, then disconnected slate.
- Companion exits unexpectedly: Electron restarts once without touching the caption session.
- Camera busy during stop/update: report the HRESULT and advise release/reselection; do not loop elevation prompts.
- App exit or output-mode switch: stop frame subscription, mark writer stopped, close the region, stop and shut down the camera, then end the companion.

## Installation lifecycle

The unsigned internal installer stages `vcam-host.exe` and `twinscript-vcam-source.dll` in an app-owned machine-readable directory. A dedicated **Install native camera** control invokes one elevated registration action that performs HKLM COM registration and creates the protected ProgramData runtime directory; ordinary camera starts thereafter require no elevation. A matching remove/repair action is available from Advanced settings, and uninstall invokes machine unregistration before removing the binaries. Registration and unregistration remain idempotent and return exact HRESULT/Win32 diagnostics.

## Automated evidence

Automated W4 evidence must include:

1. source contract checks and native build;
2. in-process sample drive;
3. separate-process virtual-camera consumption;
4. real shared-region frames, repeat, expiry, slate, and monotonic-clock checks;
5. supervisor start, stop, OS gate, crash isolation, one restart, and second-failure behavior;
6. packaging manifest and registration command checks;
7. a bounded accelerated soak proving sequential frames and stable process memory; and
8. full caption main, renderer, and production build verification.

Manual validation remains necessary for Teams, Zoom, Chromium rendering, standard-user installed behavior, update/repair/uninstall observation, remote readability, Windows 10 UI fallback, and the real 60-minute soak.
