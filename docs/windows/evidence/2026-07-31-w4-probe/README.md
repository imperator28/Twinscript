# W4 native virtual-camera feasibility probe — 2026-07-31

```text
Commit:                        working tree on codex/phase-0-phase-1
Build type:                    native probe (Release, unsigned)
Windows edition/version/build: Windows 11 Enterprise, build 26200
Architecture:                  x64
Toolchain:                     MSVC 17.14.37411.7 (VS 2022 Build Tools),
                               Windows SDK 10.0.26100.0, CMake 4.3.4
Tester:                        maintainer
Date/timezone:                 2026-07-31, America/Los_Angeles
```

Source: [`native/camera-companion/probe/main.cpp`](../../../../native/camera-companion/probe/main.cpp)

```powershell
cmake -S native/camera-companion -B native/camera-companion/build -G "Visual Studio 17 2022" -A x64
cmake --build native/camera-companion/build --config Release
native\camera-companion\build\Release\vcam-probe.exe
```

## Result

```text
os.version                   10.0 build 26200
os.supports_mfvcam           YES (build >= 22000)
mf.startup                   0x00000000  OK
Video capture devices (1):
  [0] Integrated Camera
mf.enum_devices              0x00000000  OK
mfvcam.create_unregistered   0x00000000  created
verdict.api_callable         YES
```

| Question | Answer |
| --- | --- |
| Is the OS new enough for `IMFVirtualCamera`? | PASS — build 26200, minimum supported client is 22000. |
| Does `MFCreateVirtualCamera` link and execute from this SDK? | PASS — resolves from `mfsensorgroup.lib` and returns `S_OK`. |
| Can native code enumerate capture devices the way a meeting app does? | PASS — `MFEnumDeviceSources` with `MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID` works. |
| Does `Remove()` + `Shutdown()` leave an orphan registration? | PASS — re-enumeration shows only `Integrated Camera`, and no `HKCU` value references the probe's friendly name. |
| Can Windows Frame Server load an **unsigned, locally built** COM media source? | **STILL UNKNOWN — see below.** |

## The important finding

`MFCreateVirtualCamera` returned `S_OK` for a source CLSID that was deliberately
**never registered**. Windows does not validate the COM source at creation time;
it defers resolution until a consumer actually opens the camera.

That moves the W4 kill risk rather than clearing it. "The camera was created and
appears in the device list" is therefore *not* evidence that the camera works —
a broken or unloadable media source produces exactly the same `S_OK`. The real
question is whether Windows Frame Server will load our unsigned, locally-built
COM source when Teams, Zoom, or Chrome opens the camera, and that cannot be
answered until the media source itself exists.

Do not report W4 as feasible on the strength of this probe. It establishes that
the toolchain, OS, and API surface are ready, and that lifecycle cleanup is
sound.

## Secondary observation

`OBS Virtual Camera` was **not** enumerated during this run, because OBS was not
running. The W3 status note in
[`../../README.md`](../../README.md) records that Chrome listed `OBS Virtual
Camera` — that holds only while OBS's virtual camera is started. Any W3 or W4
comparison should state whether OBS was active at the time.

## Next decisive step

Write the minimal COM media source (`IMFMediaSource` + `IMFMediaStream`
producing a static test pattern), register it under `HKCU`, point
`MFCreateVirtualCamera` at its real CLSID, then open the camera from a consumer.
Three outcomes:

- **Consumer receives frames** — the architecture is viable unsigned, and
  signing stays a W5 distribution concern.
- **Frame Server refuses to load the unsigned DLL** — W4 becomes blocked on W5
  code signing, which is a schedule finding worth knowing before any
  shared-memory or frame-clock work is invested.
- **Loads but starves** — the frame transport contract needs revisiting before
  the companion is built out.
