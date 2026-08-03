# W4 control experiment — Microsoft reference camera, 2026-08-02

**Status: built and staged, not yet run.** The final step needs one elevated
registration; the UAC prompt was cancelled, so nothing was registered and the
registry is clean. Everything before that step is done and reusable.

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

## To finish (one elevated step)

HKLM registration is required because the Frame Server runs as LocalService and
cannot read HKCU — established earlier in W4.

```powershell
Start-Process "C:\Users\Public\vcam-control\control.exe" -ArgumentList "register","C:\Users\Public\vcam-control\VirtualCameraMediaSource.dll" -Verb RunAs -Wait
& "C:\Users\Public\vcam-control\control.exe" run 10
Start-Process "C:\Users\Public\vcam-control\control.exe" -ArgumentList "unregister" -Verb RunAs -Wait
```

The middle command runs unelevated on purpose — a meeting app is unelevated.

Read the result as: frames delivered → the fault is ours; `0xC00D3EA2` on
`ReadSample` → environmental, and the harness labels that case explicitly.

## Cleanup owed

- `HKLM\Software\Classes\CLSID\{7B89B92E-…}` — only if the register step is run.
- `C:\Users\Public\vcam-control\` — staged harness and reference DLL.
- Pre-existing from earlier sessions, still outstanding: orphaned
  `C:\ProgramData\Bilingual Meeting Captions\` and four debug staging
  directories under `C:\Users\Public\`.
