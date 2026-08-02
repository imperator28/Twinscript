# Native camera companion (W4)

Windows-only. Implements the native virtual-camera path described in
[`../../docs/windows/virtual-camera.md`](../../docs/windows/virtual-camera.md),
which replaces the OBS bridge for supported Windows 11 systems.

**Status 2026-08-01:** production implementation is complete; user manual
validation is pending. This is not a claim that the W4 gate passed. See
[`../../docs/windows/evidence/2026-08-01-w4-production/README.md`](../../docs/windows/evidence/2026-08-01-w4-production/README.md).

## Layout

```text
native/camera-companion/
├── CMakeLists.txt
├── include/frame_transport.h        # shared-memory contract (C++ side)
├── src/frame_transport_check.cpp    # compiles the contract's static_asserts
└── probe/main.cpp                   # stage-0 feasibility probe
```

## Build

Requires Visual Studio 2022 Build Tools with **Desktop development with C++**
and a Windows 11 SDK. Verified with MSVC 17.14 and SDK 10.0.26100.

```powershell
cmake -S native/camera-companion -B native/camera-companion/build -G "Visual Studio 17 2022" -A x64
cmake --build native/camera-companion/build --config Release
```

`build/` is gitignored. Do not point it under `%TEMP%` — MSBuild refuses to place
intermediate output there (`MSB8029`, then a hard `MSB6003` on the `.tlog` path).

## Frame contract

`include/frame_transport.h` and
[`../../electron/captions/camera-frame-transport.js`](../../electron/captions/camera-frame-transport.js)
describe the same bytes. Both must change together:

- `electron/captions/camera-frame-transport.test.cjs` parses the C++ header and
  fails if any constant, offset, or writer-state value diverges.
- Building `frame_transport_check` executes the header's `static_assert`s.

Frames never travel as IPC messages — at 1920×1080 BGRA8 one frame is ~8 MB. IPC
is for lifecycle and health only.

Publication uses a seqlock over two slots: the writer fills the slot for
sequence `S+1`, then stores `S+1` as its final operation. A reader samples the
sequence, copies the slot, and re-samples; a change means it was lapped, so the
read is discarded and retried. A stalled reader can never block the frame clock.

## Stage 0 probe: what it established

Run: `native\camera-companion\build\Release\vcam-probe.exe`
Evidence: [`../../docs/windows/evidence/2026-07-31-w4-probe/README.md`](../../docs/windows/evidence/2026-07-31-w4-probe/README.md)

Confirmed on Windows 11 build 26200 x64:

- the OS clears the build-22000 minimum for `IMFVirtualCamera`;
- `MFCreateVirtualCamera` links from `mfsensorgroup.lib` and executes;
- native code enumerates capture devices the way a meeting app does;
- `Remove()` + `Shutdown()` leaves no orphan registration.

**The probe also moved the kill risk rather than clearing it.**
`MFCreateVirtualCamera` returned `S_OK` for a source CLSID that was never
registered — Windows defers COM source resolution until a consumer opens the
camera. So "the camera was created and appears in the device list" is *not*
evidence that it works; a broken or unloadable media source produces the same
`S_OK`.

## Production status (2026-08-01)

The question above is **answered: signing is not the blocker.** An unsigned,
locally-built COM source is accepted. Full results in
[`../../docs/windows/evidence/2026-07-31-w4-media-source/README.md`](../../docs/windows/evidence/2026-07-31-w4-media-source/README.md).

Working: registration, `IMFActivate` → `ActivateObject`, in-process frame pull
(1920×1080 RGB32, 8,294,400 bytes/frame, sequential ordinals),
`MFCreateVirtualCamera`, `IMFVirtualCamera::Start`, and Windows enumerating the
camera as `Twinscript (Windows Virtual Camera)`.

The `MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED` path is corrected: the source now
uses stream zero, copies activation attributes, follows the `IMFActivate`
lifecycle contract, uses Media Foundation timestamps and 2D buffers, and offers
NV12 first with RGB32 as a zero-copy alternate. The in-process harness delivers
20 sequential non-frozen 1920×1080 samples.

Three corrections to the original design assumptions, all found empirically:

1. The registered CLSID must be an **`IMFActivate`**, not the media source.
2. Registration must be **machine-wide (HKLM)** — the broker runs as
   `NT AUTHORITY\LocalService` and cannot read a user's `HKCU`. The selected
   answer is an explicit one-time elevated Install action with stable
   ProgramData binaries, plus Repair/Remove and Squirrel cleanup.
3. The camera lifetime belongs to the separate companion. Pixel production is
   independently consumed by the Frame Server-hosted COM source from the mapped
   ProgramData region.

## Implemented production path

- never-shown Electron offscreen stage at 1920×1080/15 fps;
- bounded latest-frame BGRA publisher and versioned double-buffered region;
- read-only native mapping with fresh/repeat/expiry/idle/stopped handling;
- neutral privacy/disconnected slate after the two-second repeat window;
- health-only named pipe and separate companion lifetime;
- Windows 11 x64 gating, graceful stop, one automatic restart, manual retry;
- explicit one-time elevated Install plus Repair and Remove;
- Administrator/SYSTEM-owned ProgramData binaries, a dedicated user-writable
  `runtime` region, packaged-version drift detection, Squirrel uninstall
  cleanup, and packaged host/DLL/scripts; and
- diagnostics under `C:\ProgramData\Twinscript\logs` without
  transcript text.

## Still requires user validation

- approve the explicit UAC install for the newly built binaries;
- run `vcam-host consume` as a separate installed consumer while the app is in
  Virtual camera mode;
- verify Teams, Zoom, and Chromium rendering;
- verify standard-user install/update/repair/remove and no orphan registration;
- kill the real companion during live transcription and observe one recovery;
- confirm Windows 10 OBS fallback; and
- complete the 60-minute soak.

## Harness commands

```text
vcam-host register            HKCU registration (no elevation; in-process only)
vcam-host unregister
vcam-host register-machine    HKLM registration (requires elevation)
vcam-host unregister-machine
vcam-host status-machine      verify HKLM points to this adjacent source DLL
vcam-host drive [n]           pull n frames straight from the source
vcam-host camera [seconds]    create the virtual camera and hold it open
vcam-host consume [n]         enumerate, activate, and read n frames
vcam-host serve --region <file> --pipe <name>
vcam-probe                    OS/API feasibility and device enumeration
```
