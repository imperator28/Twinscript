# W4 control experiment — Microsoft reference camera, 2026-08-02

## Result: the reference camera STREAMS. The fault was ours.

```
ok    MFCreateVirtualCamera
ok    IMFVirtualCamera::Start
      [1] MSRefControlCam (Windows Virtual Camera)
ok    ActivateObject
      frame  1  ts=8404462362585  bytes=460800
      ...
PASS  9/10 frames delivered
```

640×480 NV12, advancing timestamps, HKLM key removed afterwards and verified
gone. Frame 0 carried no sample (`flags=0x100`, a stream tick), which is normal.

**This eliminated the environmental hypothesis.** Windows, the Frame Server, and
this machine can all host an unsigned software virtual camera end to end.

## What the interface diff then showed

With a known-good source on the same machine, both sources were asked directly
which interfaces they implement (`control.exe probe <clsid> <dll>`, HKCU
registration, no elevation needed):

| Interface | Reference | Ours (before) |
| --- | --- | --- |
| `IMFMediaSource` | YES | YES |
| `IMFMediaSourceEx` | YES | YES |
| `IMFGetService` | YES | YES |
| `IMFSampleAllocatorControl` | **YES** | **no** |
| `{2032C7EF-…}` | no | no |

Two conclusions, one of which closed a long-running dead end.

**`{2032C7EF-76F6-492A-94F3-4A81F69380CC}` is a red herring.** It was treated
across three sessions as the blocking unknown — the undocumented interface
Windows queries right after activation and which we refuse. The reference refuses
it too, and the reference streams. Refusing it was never the cause.

**`IMFSampleAllocatorControl` was the difference**, and it is the only one. The
mechanism accounts for the symptom exactly: a source implementing it reports
`MFSampleAllocatorUsage_UsesProvidedAllocator`, and the Frame Server then hands
over an allocator *it* owns, whose samples live in memory it can forward to a
consumer. Without the interface the server cannot negotiate buffers at all, so it
inspects the source and abandons the pipeline — activation succeeds, `Start` and
`RequestSample` are never called, and the consumer eventually sees
`MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED`. Our stream had been allocating its own
buffers with `MFCreate2DMediaBuffer`, which are process-local and of no use to
the server.

## Hardware status, 2026-08-03: PROGRESS, NOT CONFIRMED

An earlier revision of this file claimed the blank feed was resolved. That was
**wrong** and is retracted. It rested on a reported `PASS` line that the captured
terminal does not contain. What the run actually produced:

```
ok    registered {6B8F2C4A-9D3E-4A17-8C25-1E7B4F6D9A03} under HKLM
ok    machine registration points to ...\twinscript-vcam-source.dll
ok    MFCreateVirtualCamera
ok    IMFVirtualCamera::Start
      device: Integrated Camera
      device: Twinscript (Windows Virtual Camera)
ok    camera enumerated by friendly name
ok    ActivateObject(camera)
                                  <-- output ends here; prompt returns
```

No frame lines, no verdict, no `--- 4. cleanup ---`. The script never reached its
end, which also explains the "cleanup did not run" puzzle: the `finally` block
never executed because the run was interrupted, not because of a logic bug. The
HKLM key was then removed manually.

### What did change

`ActivateObject` on the *camera* now succeeds and the camera enumerates. The
previous symptom was `ReadSample` failing immediately with
`MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED` (`0xC00D3EA2`). No such error appeared
this time; the run simply produced no frames before being interrupted.

The most likely reading is that `ReadSample` now **blocks** rather than failing —
`ConsumeCamera` calls it synchronously with no timeout, so a Frame Server that
never delivers hangs the harness indefinitely with no output. That is a different
failure from before, but it is not success.

### Settled: the allocator was NOT the cause

Verified in a meeting client: Teams lists and selects **Twinscript (Windows
Virtual Camera)**, and the feed is blank. Enumeration works; frames do not.

`C:\ProgramData\Twinscript\logs\vcam-source.log` is decisive, because
`NT AUTHORITY\LOCAL SERVICE` holds Modify on that directory — so a Frame Server
load would be logged.

| Process that has ever loaded our DLL | Count |
| --- | --- |
| `vcam-host.exe` (our own host) | 374 |
| `control.exe` (the probe harness) | 21 |
| `svchost` / `frameserver` / `dllhost` | **0** |

**The Frame Server has never instantiated our media source.** Every run ends the
same way, unchanged by the allocator work:

```
DllGetClassObject               match=1
ClassFactory::CreateInstance    0x00000000
MediaSourceActivate::ActivateObject 0x00000000
MediaSource QueryInterface REFUSED {2032C7EF-…}
MediaSource QueryInterface REFUSED {5BC8A76B-…}
MediaSource QueryInterface REFUSED {B91EBFEE-…}
                                        <-- nothing further, ever
```

No `GetAllocatorUsage`, no `SetDefaultAllocator`, no `Start`, no `RequestSample`.
The allocator handshake is never reached, so implementing it could not have
helped. It is a real difference from the reference and probably still required
eventually, but it is **not** the blocker.

### A correction I got backwards

The earlier ETW note judged `IMFSampleAllocatorControl` as *"may be latent rather
than causal"* because Windows never queried its IID. I overrode that as "too
confident — absence from a trace is not absence from the contract." **The original
judgment was right and my override was wrong.** Windows genuinely never asks for
it, and the log confirms that independently of ETW.

### Where the difference actually is

Both sources refuse the same three IIDs, and the reference streams — so the
divergence is *before* source-interface negotiation. The Frame Server decides not
to host our source at all. The remaining known differences from the reference are
therefore the candidates:

1. **`MF_DEVICEMFT_SENSORPROFILE_COLLECTION`** — the reference publishes a sensor
   profile collection; we publish none. The Frame Server uses sensor profiles to
   decide what a device can do, which is exactly the kind of thing that would make
   it decline to host. Highest-value next step.
2. `MF_VIRTUALCAMERA_CONFIGURATION_APP_PACKAGE_FAMILY_NAME`.

A sharper experiment is also available now: add logging to the reference DLL, or
diff the two activate objects' attribute sets, and see what the Frame Server reads
from the reference that it does not get from us.

### Harness defect that made this ambiguous

`ConsumeCamera` calls `ReadSample` synchronously with no timeout, so "no frames"
hangs indefinitely instead of failing. That is why a run could look like it might
have succeeded. Bound it before trusting the harness again.

## Why `drive` passed for weeks while the camera delivered nothing

`vcam-host drive` activates the source in-process, and in-process activation never
involves the Frame Server. The harness was exercising a path Windows never takes,
so it could not observe the missing allocator negotiation. `drive` now plays the
server's role — QI the interface, read the usage, create and hand over an
allocator — so it covers the negotiation rather than bypassing it.

---

## Appendix: build recipe (reusable)

## Why this experiment

Our media source enumerates and activates, then `MediaSource::Start` and
`RequestSample` are never called and a consumer gets
`MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED`. Six hypotheses have been eliminated
(see `../2026-08-02-w4-etw-and-reference-diff/README.md`), and the blocking
unknown — IID `{2032C7EF-…}` — cannot be resolved by lookup.

This holds the **consumer constant** and swaps in a **known-good source**:

- reference camera streams here → the fault is in our media source, and the
  three known reference gaps are the search space;
- reference camera fails identically → the fault is environmental and no change
  to our source can help.

Either outcome is decisive, which is why it ranks above implementing the
remaining gaps speculatively.

## The recorded blocker was wrong

The earlier note said `vswhere` resolved no MSBuild instance. It does. The
toolchain was present the whole time — this repo's own CMake build uses the
`Visual Studio 17 2022` generator, which drives MSBuild.

## Build recipe (works; reproducible)

Two real obstacles, both solved without downloading anything:

1. **Long paths.** Cloning into the session scratchpad fails: ~150 characters of
   prefix before the repo starts, and the sample's paths are deep. Clone to a
   short path, and sparse-checkout only the sample.

   ```bash
   git -c core.longpaths=true clone --depth 1 --filter=blob:none --sparse https://github.com/microsoft/Windows-Camera.git wc
   git -c core.longpaths=true sparse-checkout set Samples/VirtualCamera
   ```

2. **NuGet is absent** — no `nuget.exe`, no package cache, and `dotnet restore`
   cannot restore `packages.config`-style projects. Not needed, because:

   | Dependency | Source used instead |
   | --- | --- |
   | `Microsoft.Windows.CppWinRT` | The Windows SDK already ships all 344 projection headers under `Include\10.0.26100.0\cppwinrt\`, including the `winrt/Windows.ApplicationModel.h` the sample needs. |
   | `Microsoft.Windows.ImplementationLibrary` (WIL) | `git clone --depth 1 https://github.com/microsoft/wil` — header-only. |

   The project hard-fails on missing packages via an
   `EnsureNuGetPackageBuildImports` target, satisfied with four no-op stub
   `.props`/`.targets` files at the expected paths. The include directories are
   injected through a props file passed as `ForceImportBeforeCppTargets`, rather
   than `/p:AdditionalIncludeDirectories` — MSBuild cannot parse semicolons in a
   command-line property value.

   ```
   msbuild VirtualCameraMediaSource.vcxproj /p:Configuration=Release /p:Platform=x64 \
     /p:SolutionDir=<...>\Samples\VirtualCamera\ \
     /p:ForceImportBeforeCppTargets=<...>\control-includes.props
   ```

   Result: `x64\Release\VirtualCameraMediaSource.dll`, clean.

Only `VirtualCameraMediaSource` is needed. `VirtualCameraManager_App` and
`VirtualCameraSystray` are UWP/.NET projects irrelevant to the control, and the
sample's own installer is interactive (`std::wcin`), so it was not used.

## Experimental controls applied

- **Same consumer.** The harness reproduces our `vcam-host` consumer path
  exactly: `MFEnumDeviceSources` → friendly-name prefix match →
  `ActivateObject` → `MFCreateSourceReaderFromMediaSource` → `ReadSample`.
- **Same class of source.** With no `VCAM_KIND` attribute the reference activate
  defaults to `VirtualCameraKind::Synthetic` (= 0), which is `SimpleMediaSource`
  — a pure software generator with no physical-camera dependency, matching ours.
  `BasicCameraWrapper` and `AugmentedCameraWrapper` would have needed a real
  camera and confounded the result.
- **Distinct CLSID.** Reference is `{7B89B92E-FE71-42D0-8A41-E137D06EA184}`,
  ours is `{6B8F2C4A-…}`. Both can be registered at once; no interference.
- **Readable path.** The DLL is staged at `C:\Users\Public\vcam-control\`, not
  under the user profile temp directory. The Frame Server runs as
  `NT AUTHORITY\LocalService`; `NT AUTHORITY\SERVICE` has access to the staged
  copy, so DLL-load failure cannot be mistaken for a streaming failure.

## Blocked on elevation, not on code

HKLM registration is required because the Frame Server runs as LocalService and
cannot read HKCU — established earlier in W4.

Three attempts to elevate from the agent's process context all returned
`The operation was canceled by the user`; the UAC consent prompt goes to the
secure desktop and never became approvable. Diagnosis:

| Fact | Value |
| --- | --- |
| Account | `SIMPLEHUMAN\jqian`, **is** a member of `BUILTIN\Administrators` (AzureAD) |
| Token | Administrators present but **"Group used for deny only"** — normal split-token Admin Approval Mode |
| `EnableLUA` | `1` |
| `ConsentPromptBehaviorAdmin` | `5` (consent prompt for non-Windows binaries) |
| `PromptOnSecureDesktop` | `1` |

So the account can elevate; the prompt simply is not reachable from here. Nothing
was registered on any attempt — HKLM is clean, no partial state.

## To finish — one command, from an elevated PowerShell

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Public\vcam-control\run-control-experiment.ps1"
```

It registers, reads frames, prints a verdict, unregisters, verifies the HKLM key
is gone, and writes everything to
`C:\Users\Public\vcam-control\control-result.log`.

It refuses to run unelevated rather than failing obscurely in the middle.

The consumer runs elevated inside that script so the whole experiment needs one
approval. That does not weaken the result: the Frame Server hosts the media
source in its own LocalService process either way, so whether the *consumer* is
elevated has no bearing on whether `MediaSource::Start` is ever called.

Read the result as: frames delivered → the fault is ours; `0xC00D3EA2` on
`ReadSample` → environmental. The script states the verdict explicitly rather
than leaving it to interpretation.

## Cleanup owed

- `HKLM\Software\Classes\CLSID\{7B89B92E-…}` — only if the register step is run.
- `C:\Users\Public\vcam-control\` — staged harness and reference DLL.
- Pre-existing from earlier sessions, still outstanding: orphaned
  `C:\ProgramData\Bilingual Meeting Captions\` and four debug staging
  directories under `C:\Users\Public\`.
