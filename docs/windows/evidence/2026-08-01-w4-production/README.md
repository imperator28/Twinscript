# W4 native camera production implementation — 2026-08-01

## Outcome

**Implementation complete; user manual validation pending.** The former
`MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED` source defect, real frame transport,
companion supervision, explicit elevation lifecycle, and packaging gaps are
closed in code. W4 is not marked passed because UAC installation, independent
meeting-client consumers, standard-user lifecycle, and a 60-minute soak require
the owner at the Windows desktop.

The user canceled the first UAC registration attempt during development. That
left the profile intentionally unchanged and is recorded as a manual boundary,
not as passing or failing product evidence. Do not infer that the newly built
DLL has machine-wide registration until the Install native camera action is
approved and `status-machine` succeeds.

## Implemented

- Media Foundation source contract: zero-based stream, activation-attribute
  copy, correct activation lifecycle, MF timebase, 2D buffers, NV12/RGB32.
- A never-shown Electron offscreen compositor independent of the optional
  Preview/Hide preview window.
- Preallocated 1920×1080 BGRA8 double-buffered ProgramData region with
  sequence-last publication and one pending latest frame under backpressure.
- Native read-only file mapping, coherent sequence sampling, two-second repeat,
  and privacy/disconnected slate fallback.
- Separate `serve` companion with health-only named pipe control, graceful stop,
  one automatic restart, and failure isolation from transcription.
- Windows 11 build-22000 x64 gate with OBS fallback elsewhere.
- Inline Install and persistent Repair/Remove/Retry controls. Elevation occurs
  only for an explicit lifecycle action.
- Stable ProgramData target, fixed CLSID, ACLs for the operator and Frame Server,
  machine registration verification, Squirrel cleanup, and packaged resources.
- Administrator/SYSTEM-owned install and binary directories, with user write
  access restricted to `runtime` and diagnostics. Repair never executes the
  prior installed host, and installed/package byte drift requires Repair.
- Live COM-object unload accounting, serialized start/stop, spawn-error retry,
  a coordinated Electron quit barrier, and destruction of the offscreen
  renderer whenever native output stops.

## Automated evidence captured

| Check | Result |
| --- | --- |
| Caption main-process suite | Pass: 246 tests. |
| Renderer suite | Pass: 5 files, 56 tests. |
| Production Vite build | Pass. |
| Fresh native Release build | Pass from a unique temporary CMake staging directory with MSVC 17.14 and Windows SDK 10.0.26100. |
| Native mapped states | Pass: starting, fresh, repeat, expired, idle, stopped, malformed, mapped-stage preference, expired-stage slate. |
| Full-size cross-language transport | Pass: Node-published 8,294,400-byte 1920×1080 BGRA frame read by the C++ mapped reader. |
| Media source drive | Pass: NV12 and RGB32 offered at 1920×1080/15; 20 NV12 samples, 3,110,400 bytes each, advancing timestamps, sequential ordinals 0–19, paced over 1.35 seconds rather than emitted in a CPU-bound burst. |
| Supervisor contracts | Pass: gating, named-pipe arguments, health parsing, graceful stop, spawn-error cleanup, exactly one restart, second-failure manual state, transcription independence. A real installed-process kill remains manual below. |
| Lifecycle churn | Pass: rapid race coverage plus 50 Virtual camera ↔ overlays cycles leave no companion or offscreen renderer alive. This is deterministic lifecycle evidence, not the 60-minute resource soak. |
| PowerShell lifecycle scripts | Pass: install, remove, and fresh-build verifier parse without errors; ACL and exact-registry-target contracts pass. |
| Unsigned package | Pass: Squirrel Setup, full `.nupkg`, and `RELEASES` created. |
| Packaged W4 resources | Pass: host, source DLL, install script, and uninstall script present under `resources/native-camera`. |
| Packaged resource integrity | Pass: packaged host, DLL, install script, and remove script SHA-256 values exactly match the verified build/source files. |
| Packaged launch smoke | Pass: the rebuilt x64 client remained running for the six-second smoke window and was then explicitly cleaned up. |

Packaged artifact produced locally:

```text
out/make/squirrel.windows/x64/Bilingual Meeting Captions-0.1.0 Setup.exe
```

Final artifact size: 140,391,424 bytes. Native source DLL SHA-256:
`0BB626D382385A3952D785C5F57ECCE8922DBA38215734F98B109890F5383C97`.

The artifact is unsigned and internal-only. Signing remains W5.

The installed separate-consumer path was deliberately not claimed as
automated evidence: it needs the owner's UAC approval and an app session in
Virtual camera mode. The verifier reports that boundary explicitly unless
`-InstalledConsumer` is supplied.

## Manual validation checklist

1. In Settings, choose **Install native camera** and approve the single UAC
   prompt. Confirm the UI reports installed without restarting the app.
2. Run
   `C:\ProgramData\Bilingual Meeting Captions\bin\vcam-host.exe status-machine`.
   It must report that HKLM points to the adjacent installed DLL.
3. Start a caption session, select **Virtual camera**, hide the optional preview,
   and run `scripts\verify-native-camera.ps1 -SkipBuild -InstalledConsumer` in
   another PowerShell. It must receive 30 samples.
4. Select **Bilingual Meeting Captions (Windows Virtual Camera)** in current
   Teams, Zoom, and one Chromium meeting surface. Confirm both halves render at
   the correct orientation and no control-window content is exposed.
5. While transcription is active, switch Virtual camera ↔ On-screen captions.
   Confirm captions do not restart and the camera stops/starts cleanly.
6. Kill `vcam-host.exe` once. Confirm transcription remains active and the feed
   recovers once. Kill it a second time and confirm the UI requires manual Retry.
7. Sign out/in or use a standard non-admin profile after installation. Confirm
   ordinary sessions never request elevation.
8. Exercise Repair, app update, and Remove/uninstall. After removal,
   `status-machine` must fail and the camera must disappear without an orphan.
9. On Windows 10, confirm only the OBS instructions are actionable.
10. Complete the validation-matrix 60-minute soak and record meeting-client
    versions, black/frozen frames, CPU/GPU/memory range, readability, and any
    reselect-camera behavior.

W4 may be marked passed only after these checks are captured. W2 and W3 remain
independent gates and are not waived by this implementation.
