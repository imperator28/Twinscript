# W3 OBS camera-stage evidence — 2026-07-30

This folder records direct Windows 11 evidence from the dirty
`codex/phase-0-phase-1` working tree. It does not claim that the W3 gate has
passed: meeting-client enumeration, remote readability, live history/mode
switch behavior, and the 60-minute soak still require direct observation.

## App and stage

- The production Electron package exposes four renderer surfaces: control,
  English overlay, Chinese overlay, and `?surface=camera-stage`.
- The camera stage reports a 1920 x 1080 renderer viewport.
- The native capture title is pinned to `Bilingual Camera Stage`, so OBS can
  distinguish it from `Twinscript`.
- The privacy slate contains only `EN / 中`, `Bilingual captions ready`, and
  its neutral meeting-start explanation.
- `node --test electron/captions/meeting-record-ipc.test.cjs
  electron/captions/overlay-layout.test.cjs` passed 27/27 tests after adding
  the startup/title and serializable IPC guards.

## Official OBS payload

- Release: OBS Studio 32.1.2 x64 from the official
  `obsproject/obs-studio` GitHub release.
- Installer:
  `C:\Users\jqian\AppData\Local\Temp\OBS-Studio-32.1.2-Windows-x64-Installer.exe`
- SHA-256:
  `94D180C1FC481CCC307B95513F795D088D63AC4F61AD3253C2AC0D94D0844110`
- Installer Authenticode status: valid; signer `OBS Project, LLC`.
- The verified installer payload was extracted to
  `C:\Users\jqian\AppData\Local\Temp\obs-portable-32.1.2`.
- Portable `obs64.exe --portable --version` reported `OBS Studio - 32.1.2`.
- OBS WebSocket 5.7.3 is enabled on localhost with authentication retained.
- The verified installer was approved and installed system-wide. The installed
  `C:\Program Files\obs-studio\bin\64bit\obs64.exe --version` reports
  `OBS Studio - 32.1.2`.
- Both 64-bit and 32-bit virtual-camera registrations use CLSID
  `{A3FCE0F5-3493-419F-958A-ABA1250EC20B}` and point to Authenticode-valid
  `OBS Project, LLC` modules under `C:\Program Files\obs-studio`.

## OBS scene

- Scene: `Bilingual Captions`.
- Base canvas: 1920 x 1080.
- Output: 1920 x 1080.
- Frame rate: 30/1 fps.
- Source: Windows `window_capture`, named `Bilingual Camera Stage`.
- Target:
  `Bilingual Camera Stage:Chrome_WidgetWin_1:twinscript.exe`.
- Capture method: Windows 10 (1903 and up); client area on; cursor off.
- The 2880 x 1620 DPI-scaled source is fitted into 1920 x 1080 with
  `OBS_BOUNDS_SCALE_INNER`.
- [OBS output screenshot](obs-camera-stage.png) shows the neutral privacy
  slate filling a 1280 x 720 evidence frame without window chrome, clipping,
  transparency, or private application state.

## Remaining meeting-client validation

- Authenticated OBS WebSocket `StartVirtualCam` succeeds and
  `GetVirtualCamStatus` reports `outputActive: true`.
- A normal installed Google Chrome instance enumerates `OBS Virtual Camera`
  alongside the integrated camera. Selecting it negotiates a live 1920 x 1080,
  30 fps, 16:9 media track without fake-camera flags.
- Chrome visual rendering remains **IN PROGRESS**. The first live-frame check
  correctly exposed a missing OBS Window Capture source after the earlier app
  process ended; a new native camera-stage window must be selected before the
  frame can be counted as passed.
- Zoom/Teams enumeration and rendering: **NOT RUN**.
- Remote-attendee readability: **NOT RUN**.
- Live 3-10 history and overlay/camera mode switch in OBS: **NOT RUN**.
- 60-minute soak: **NOT RUN**.
