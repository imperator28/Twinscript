# W4 Native Windows Camera Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete every automatable W4 native-camera requirement and leave only real meeting-client, installed-profile, and 60-minute manual validation.

**Architecture:** A never-shown Electron offscreen stage publishes BGRA paint frames into the existing double-buffered protocol using a preallocated ProgramData region file; the existing stage window remains optional preview only. The out-of-process companion supervises `IMFVirtualCamera`, while the COM source memory-maps the region and supplies coherent frames or a bounded neutral slate. Electron supervises the companion through lifecycle events and health-only messages.

**Tech Stack:** Electron 40, Node.js filesystem/child-process APIs, C++20, Win32 file mapping and named pipes, Media Foundation `IMFMediaSourceEx`/`IMFVirtualCamera`, Node test runner, CMake/MSBuild.

**Execution status 2026-08-01:** Tasks 1–6 and every non-elevated Task 7
implementation/verification item are complete. A fresh temporary native build,
full-size Node→C++ transport, paced 20-frame source drive, 246 main-process
tests, 56 renderer tests, production build, accelerated lifecycle churn, and
unsigned packaging pass. Task 7's machine-wide installed consumer, real process
kill in an active session, meeting-client matrix, standard-user lifecycle, and
60-minute resource soak remain owner manual validation because they require UAC
approval or interactive third-party clients. The unchecked recipe below is
retained as the original TDD execution record; the evidence README is the
authoritative completion status.

---

### Task 1: Media Foundation contract compliance

**Files:**
- Modify: `native/camera-companion/src/source/media_source.cpp`
- Modify: `native/camera-companion/src/source/media_source.h`
- Modify: `native/camera-companion/src/source/media_source_activate.cpp`
- Modify: `native/camera-companion/src/source/frame_source.h`
- Modify: `native/camera-companion/src/source/media_stream.cpp`
- Test: `electron/captions/native-camera-source-contract.test.cjs`

- [ ] Add a source-contract test that asserts stream zero, activation-attribute copying, `E_NOTIMPL` lifecycle methods, `MFGetSystemTime`, and two-dimensional buffers.
- [ ] Run `node --test electron/captions/native-camera-source-contract.test.cjs` and confirm it fails against the current source.
- [ ] Change `MediaSource::CreateInstance` to accept optional activation attributes, copy them into source attributes, use stream ID zero, return `E_NOTIMPL` from activation shutdown/detach, base timestamps on `MFGetSystemTime`, and allocate 2D uncompressed buffers.
- [ ] Re-run the focused test and `cmake --build native/camera-companion/build --config Release`; expect both to pass.
- [ ] Run `vcam-host.exe register` and `vcam-host.exe drive 20`; expect sequential non-frozen samples.

### Task 2: Native mapped-region reader and fallback frames

**Files:**
- Create: `native/camera-companion/src/source/mapped_frame_reader.h`
- Create: `native/camera-companion/src/source/mapped_frame_reader.cpp`
- Create: `native/camera-companion/src/mapped_frame_reader_check.cpp`
- Modify: `native/camera-companion/src/source/frame_source.h`
- Modify: `native/camera-companion/src/source/media_stream.cpp`
- Modify: `native/camera-companion/CMakeLists.txt`

- [ ] Add a native check that creates a small protocol region and expects fresh, repeated, expired, malformed, idle, and stopped outcomes; confirm the target fails to build because the reader does not exist.
- [ ] Implement read-only file mapping, protocol validation, sequence-before/after coherence checks, latest-frame copying, and two-second expiry classification.
- [ ] Make `FrameSource` prefer coherent mapped BGRA input and generate privacy/disconnected slates otherwise; retain synthetic frames only for the explicit `drive` harness mode.
- [ ] Build and run `mapped-frame-reader-check.exe`; expect all state checks to pass.

### Task 3: Node region publisher

**Files:**
- Create: `electron/captions/camera-region-publisher.js`
- Create: `electron/captions/camera-region-publisher.test.cjs`
- Modify: `electron/captions/camera-frame-transport.js`

- [ ] Add tests for exact preallocation, sequence-last positioned writes, one-frame backpressure, idle/stopped states, and cleanup; confirm failure because the publisher is absent.
- [ ] Implement an asynchronous positioned-write publisher that initializes the existing header, alternates slots, drops an unpublished stale frame instead of queueing, and exposes metrics without pixel contents.
- [ ] Run the focused tests and the full caption main suite.

### Task 4: Stage compositor capture

**Files:**
- Create: `electron/captions/camera-stage-frame-publisher.js`
- Create: `electron/captions/camera-stage-frame-publisher.test.cjs`
- Modify: `electron/captions/caption-window-manager.js`
- Modify: `electron/captions/overlay-layout.test.cjs`

- [ ] Add tests proving an offscreen output window starts only for native output, publishes 1920×1080 paint bitmaps at a bounded 15 fps, resizes mismatched images, ignores empty frames, remains active when preview hides, and ends on mode switch/app shutdown.
- [ ] Confirm the new tests fail before implementation.
- [ ] Implement the compositor adapter around the offscreen `paint` event, `NativeImage.resize`, and `toBitmap`; keep at most one pending publish.
- [ ] Wire a never-shown offscreen stage to camera lifecycle while leaving Preview/Hide preview independent from background frame production.
- [ ] Run focused and full caption tests.

### Task 5: Companion health protocol and supervision

**Files:**
- Create: `electron/captions/native-camera-supervisor.js`
- Create: `electron/captions/native-camera-supervisor.test.cjs`
- Modify: `native/camera-companion/src/host/main.cpp`
- Modify: `electron/captions/caption-window-manager.js`
- Modify: `electron/captions/register-caption-ipc.js`
- Modify: `electron/captions-preload.js`
- Modify: `src/electron.d.ts`
- Modify: `src/captions/ControlApp.tsx`
- Modify: `src/captions/ControlApp.test.tsx`

- [ ] Add supervisor tests for Windows build gating, spawn arguments, ready/streaming/failed parsing, graceful stop, one unexpected-exit restart, second-failure manual state, and transcription independence.
- [ ] Confirm focused tests fail because the supervisor is absent.
- [ ] Add `serve --region <path> --pipe <name>` to the companion with machine-readable health lines and camera lifetime ownership.
- [ ] Implement the Electron supervisor with dependency-injected spawn/platform/version for deterministic tests.
- [ ] Expose a narrow health snapshot/event and render non-blocking native-camera status plus Install/Repair/Remove actions in Advanced settings.
- [ ] Run focused, renderer, and full caption suites.

### Task 6: Registration and packaging lifecycle

**Files:**
- Modify: `forge.config.js`
- Modify: `electron/captions/squirrel-startup.js`
- Modify: `electron/captions/squirrel-startup.test.cjs`
- Create: `scripts/install-native-camera.ps1`
- Create: `scripts/uninstall-native-camera.ps1`
- Modify: `.github/workflows/windows-ci.yml`
- Modify: `electron/captions/register-caption-ipc.js`
- Modify: `electron/captions-preload.js`
- Modify: `src/electron.d.ts`
- Modify: `src/captions/ControlApp.tsx`
- Modify: `src/captions/ControlApp.test.tsx`

- [ ] Add tests that assert packaged native binaries, stable CLSID, idempotent elevated registration/unregistration commands, exact target paths, and Windows-11-only UI availability.
- [ ] Confirm the packaging/lifecycle tests fail before adding resources and scripts.
- [ ] Stage the companion and source DLL as Windows-only package resources, add explicit registration/removal scripts, and wire the one-time elevated Install native camera action plus Advanced repair/remove actions without repeated ordinary-run elevation.
- [ ] Run package-content tests and create the unsigned Windows installer.

### Task 7: Separate-consumer, crash, recovery, and soak evidence

**Files:**
- Modify: `native/camera-companion/src/host/main.cpp`
- Create: `scripts/verify-native-camera.ps1`
- Update: `docs/windows/evidence/2026-08-01-w4-production/README.md`
- Update: `docs/windows/README.md`
- Update: `docs/windows/implementation-guide.md`
- Update: `docs/windows/validation-matrix.md`
- Update: `docs/windows/virtual-camera.md`

- [ ] Build into a fresh machine-readable staging directory and register the source machine-wide.
- [ ] Run a companion host and a separate `consume` process; require sequential real shared-region frames at 1920×1080 and advancing QPC-based timestamps.
- [ ] Kill the companion during an active mock caption session; require transcription state to remain active and exactly one automatic restart.
- [ ] Run an accelerated native soak that covers fresh frames, repeats, expiry slate, mode switches, and bounded process memory.
- [ ] Run `npm.cmd run test:captions`, `npx.cmd vitest run --maxWorkers=1`, `npm.cmd run build`, native Release build/checks, and `git diff --check`.
- [ ] Update W4 status to “implementation complete; manual validation pending” only when every automated command exits zero, and record the remaining manual checklist without claiming those checks passed.
