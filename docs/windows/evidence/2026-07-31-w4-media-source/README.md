# W4 native virtual camera — media source verification, 2026-07-31

```text
Commit:                        working tree on codex/phase-0-phase-1
Build type:                    native Release, unsigned
Windows edition/version/build: Windows 11 Enterprise, build 26200
Architecture:                  x64
Toolchain:                     MSVC 17.14.37411.7, Windows SDK 10.0.26100.0, CMake 4.3.4
Tester:                        jqian
Date/timezone:                 2026-07-31, America/Los_Angeles
```

Follows on from [`../2026-07-31-w4-probe/README.md`](../2026-07-31-w4-probe/README.md).

## What now works

| Stage | Result |
| --- | --- |
| COM in-proc server builds and registers under HKCU | PASS |
| `CoCreateInstance` of the CLSID for `IMFActivate` | PASS |
| `IMFActivate::ActivateObject` returns the media source | PASS |
| `IMFSourceReader` negotiates 1920×1080 @ 15/1 RGB32 | PASS |
| 10–20 frames pulled with correct size, advancing timestamps, sequential ordinals | PASS |
| `MFCreateVirtualCamera` | PASS |
| `IMFVirtualCamera::Start` with HKCU-only registration | FAIL — `0x80070003 ERROR_PATH_NOT_FOUND` |
| `IMFVirtualCamera::Start` after machine-wide (HKLM) registration | PASS |
| Windows enumerates the camera by name | PASS — `Bilingual Meeting Captions (Windows Virtual Camera)` |
| A separate consumer activates the camera | PASS |
| A separate consumer receives frames | **FAIL — `0xC00D3EA2 MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED`** |

Verified frame payload is exactly 8,294,400 bytes (1920 × 1080 × 4), matching the
BGRA8 shared-memory contract with no conversion in between.

## Finding 1: the registered CLSID must be an activation object

`MFCreateVirtualCamera` does **not** ask the registered CLSID for
`IMFMediaSource`. It asks for `IMFActivate`
(`{7FEE9E9A-4A89-47A6-899C-B6A53A70FB67}`) and calls `ActivateObject()` later to
obtain the source — observed as `ActivateObject` being invoked for
`IMFMediaSourceEx` (`{3C9B2EB9-86D5-4514-…}`).

Returning `E_NOINTERFACE` for `IMFActivate` surfaces out of
`IMFVirtualCamera::Start` as a bare `E_NOINTERFACE` with nothing pointing at the
cause. `src/source/media_source_activate.h` now provides that object.

Windows also probes three interfaces the source does not implement, and tolerates
the refusals (`Start` progressed past them):

```text
{2032C7EF-76F6-492A-94F3-4A81F69380CC}
{5BC8A76B-869A-46A3-9B03-FA218A66AEBE}
{B91EBFEE-CA03-4AF4-8A82-A31752F4A0FC}
```

## Finding 2 (blocking): the source must be registered machine-wide

`IMFVirtualCamera::Start` fails with `ERROR_PATH_NOT_FOUND` because the Windows
Frame Server cannot resolve the CLSID's `InprocServer32` path. Four
independent observations agree:

- `FrameServer` runs as **`NT AUTHORITY\LocalService`**, which does not see the
  user's `HKCU` hive.
- The CLSID exists only under `HKCU\Software\Classes\CLSID\…`; `HKLM` has no
  entry.
- The DLL's own log records exactly one loading process across every run —
  `vcam-host.exe`, our own host. The frame server never loaded it.
- Moving the DLL out of the user profile to `C:\Users\Public\bilingual-vcam\`
  (world-readable, no spaces in a parent directory) changed nothing, ruling out
  file-path ACLs and space handling.

So HKCU registration is sufficient for in-process activation — which is why the
`drive` stage passes — but not for the frame server. Machine-wide registration
under `HKLM\Software\Classes\CLSID` requires **administrator**.

### Why this matters beyond the test

The app installs through **Squirrel.Windows, per-user, without elevation**
(`docs/windows/developer-setup.md` §8). A normal install therefore *cannot*
register the native camera source. W4 needs one of:

1. an explicit in-app "Enable native camera" action that elevates once (UAC
   prompt) and writes the HKLM registration;
2. a separate elevated installer or MSI for the camera component, kept out of the
   per-user Squirrel package; or
3. staying on the OBS route, which needs no registration by this app at all.

This does not by itself break the W4 acceptance criterion that "the signed
production artifact works for a standard non-admin user after installation" —
registration can happen once at install or enable time — but it does mean the
native camera is not a drop-in addition to the existing per-user installer, and
that uninstall must remove a machine-wide registration.

## Finding 3: HKLM registration confirmed as the fix for `Start`

Registering the CLSID machine-wide (elevated, one UAC prompt) made
`IMFVirtualCamera::Start` succeed immediately, with no other change. Windows then
enumerated the camera in the ordinary device list as
`Bilingual Meeting Captions (Windows Virtual Camera)` — note that Windows
**decorates the registered friendly name**, so consumers must match on a prefix,
not the exact string.

## Finding 4: the source is hosted by the creating process, not the frame server

The DLL's log records the loading process for every activation. Across every run
it is only ever `vcam-host.exe` — the process that called
`MFCreateVirtualCamera`. The frame server never loads the DLL itself.

So for `MFVirtualCameraType_SoftwareCameraSource` with
`MFVirtualCameraLifetime_Session`, the media source runs **in-process in the
creating application**, and the frame server brokers between it and the consumer.
Two consequences for the companion design:

- The companion process must stay alive for the whole meeting; if it exits, the
  camera disappears. That matches the supervisor design already in
  [`../../virtual-camera.md`](../../virtual-camera.md).
- HKLM registration is still required even though the frame server never loads
  the DLL — the *broker* resolves the CLSID, and it runs as
  `NT AUTHORITY\LocalService`.

## Hypotheses tested and ruled out

Each was a plausible cause of the consumer-read failure; all were eliminated by
experiment rather than reasoning.

| Hypothesis | Test | Result |
| --- | --- | --- |
| The three refused interfaces are mandatory | Resolved the IIDs against the SDK headers | **Ruled out.** `{5BC8A76B}` is `IMFCollection`, `{B91EBFEE}` is `IMFExtendedCameraController`; `{2032C7EF}` appears nowhere in the SDK. All optional. |
| The DLL sits somewhere the service cannot read | Moved it to `C:\Users\Public\…` and granted `LOCAL SERVICE` (S-1-5-19) Modify on the folder | **Ruled out.** No change. |
| RGB32 is rejected; the pipeline needs NV12 | Added an NV12 media type, listed first, with BT.601 BGRA→NV12 conversion | **Ruled out as the cause**, though the support is correct and worth keeping — the source now negotiates NV12 (3,110,400 bytes = 1920×1080×1.5) with sequential ordinals decoded from the Y plane. Consumer read still fails identically. |
| `AddDeviceSourceInfo` is the missing link | Called it with `@device:pnp:\\?\root#media#0000#{KSCATEGORY_VIDEO_CAMERA}\{CLSID}` | **Ruled out, and harmful.** Fails `0x80070037 ERROR_DEV_NOT_EXIST`; the API associates a virtual camera with an *existing physical* device. Calling it leaves the camera unstarted, so it is strictly worse than omitting it. Not called. |

A blind spot was also closed: the source previously logged to `%TEMP%`, which for
the frame server is `C:\Windows\ServiceProfiles\LocalService\…` and unreadable by
the developer account. The log now sits beside the DLL in a directory the service
account can write, so frame-server-side activity would be visible. **It still
shows only `vcam-host.exe`** — the frame server genuinely never loads the DLL.

## Remaining defect: consumer read invalidates the device

With the camera started and enumerated, a separate consumer process successfully
enumerates and calls `ActivateObject`, then `ReadSample` fails with
`MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED`. The DLL log shows the source being
activated in the hosting process and then nothing further — no `Start`, no
`RequestSample`. The pipeline abandons the source between activation and
streaming.

The three interfaces the source refuses are the leading suspects, since Windows
probes all of them immediately before giving up:

```text
{2032C7EF-76F6-492A-94F3-4A81F69380CC}
{5BC8A76B-869A-46A3-9B03-FA218A66AEBE}
{B91EBFEE-CA03-4AF4-8A82-A31752F4A0FC}
```

All three are optional (see the table above), and the frame server tolerates the
refusals — they are not the cause.

### Leading remaining hypothesis: the source DLL must be signed

With registration, activation, formats, ACLs, and the device-source API all
eliminated, the most likely remaining explanation is that Windows will not let
the Frame Server load an **unsigned** COM media source. That is consistent with
the one fact nothing else explains: the frame server never calls
`DllGetClassObject` at all, so it is rejecting the module before loading it
rather than failing anything our code does.

**This corrects an earlier claim in this document's history.** After
`IMFVirtualCamera::Start` began succeeding, the working note said "signing is not
the blocker". That was premature: `Start` only exercises in-process activation by
the creating process, which never involves the frame server. Signing remains
open, and is now the leading suspect.

Testing it means creating a self-signed code-signing certificate and installing
it into the machine's Trusted Root and Trusted Publishers stores — a
security-relevant system change that needs an explicit decision before anyone
runs it. If confirmed, **W4 becomes dependent on W5 signing**, which reverses the
gate order in the handoff and is a schedule finding worth having now.

## Reproducing

```powershell
cmake -S native/camera-companion -B native/camera-companion/build -G "Visual Studio 17 2022" -A x64
cmake --build native/camera-companion/build --config Release

# Per-user registration is enough to drive the source in-process.
native\camera-companion\build\Release\vcam-host.exe register
native\camera-companion\build\Release\vcam-host.exe drive 20        # PASS

# The frame server needs the DLL machine-wide AND readable by LocalService, so
# stage it outside the user profile and register elevated (one UAC prompt).
Copy-Item native\camera-companion\build\Release\* C:\Users\Public\bilingual-vcam -Force
Start-Process C:\Users\Public\bilingual-vcam\vcam-host.exe register-machine -Verb RunAs -Wait

C:\Users\Public\bilingual-vcam\vcam-host.exe camera 45              # PASS, holds the camera
native\camera-companion\build\Release\vcam-host.exe consume 15      # FAILS at ReadSample
```

`register`/`unregister` write `HKCU`; `register-machine`/`unregister-machine`
write `HKLM` and require elevation.

The DLL appends diagnostics to `%TEMP%\bilingual-vcam-source.log`, including
which process loaded it and every refused `QueryInterface`. That log is the only
visibility into frame-server-hosted activation, which has no console.

## Machine state left behind

Left in place deliberately so the investigation can continue without another UAC
prompt. **No camera is currently exposed** — device enumeration shows only
`Integrated Camera`. A registered CLSID is inert on its own; a camera exists only
while a process holds one open, and `MFVirtualCameraLifetime_Session` plus
`Remove()` cleaned that up.

| Item | Path |
| --- | --- |
| Machine-wide COM registration (needs elevation to remove) | `HKLM\SOFTWARE\Classes\CLSID\{6B8F2C4A-9D3E-4A17-8C25-1E7B4F6D9A03}` |
| Per-user COM registration | `HKCU\Software\Classes\CLSID\{6B8F2C4A-9D3E-4A17-8C25-1E7B4F6D9A03}` |
| Staged binaries (registration points at `bilingual-vcam3`) | `C:\Users\Public\bilingual-vcam\`, `bilingual-vcam2\`, `bilingual-vcam3\` |
| Diagnostics | `C:\Users\Public\bilingual-vcam3\vcam-source.log` |

Three staging directories exist because the Frame Server keeps a loaded source
DLL locked, so each rebuild had to go to a fresh path rather than overwrite.
Restarting the `FrameServer` service releases the lock and avoids the sprawl, but
needs elevation.

To remove everything:

```powershell
Start-Process C:\Users\Public\bilingual-vcam3\vcam-host.exe unregister-machine -Verb RunAs -Wait
native\camera-companion\build\Release\vcam-host.exe unregister
Remove-Item -Recurse -Force C:\Users\Public\bilingual-vcam,C:\Users\Public\bilingual-vcam2,C:\Users\Public\bilingual-vcam3
```
