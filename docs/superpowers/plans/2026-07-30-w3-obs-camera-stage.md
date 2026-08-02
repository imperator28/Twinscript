# W3 OBS Camera Stage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a privacy-safe 16:9 bilingual camera stage, expose it through a persisted output-mode selector, install official OBS Studio, and validate the stage through OBS Virtual Camera.

**Architecture:** `CaptionWindowManager` remains the single main-process presentation hub. It lazily owns a third `BrowserWindow` for a new `CameraStage` renderer and publishes the same audience projections, status, settings, and session boundary events already used by the overlays. Settings persist only the selected output mode; the camera stage never creates an audio, transcription, or normalization connection.

**Tech Stack:** Electron, React, TypeScript, Node.js CommonJS, Vitest, Node test runner, Electron Forge, OBS Studio 32.1.2 x64.

---

### Task 1: Define camera-stage projection and privacy behavior

**Files:**
- Create: `src/captions/CameraStage.tsx`
- Create: `src/captions/CameraStage.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/captions/types.ts`

- [ ] **Step 1: Write failing renderer tests**

Test that the stage:

```tsx
render(<CameraStage />);
expect(screen.getByText('Bilingual captions ready')).toBeVisible();
expect(screen.queryByText(/API|budget|cost/i)).not.toBeInTheDocument();
```

Publish matching English and Chinese `AudienceCaption` events with the same ID and assert that one shared row appears only after both projections are aggregate-settled. Assert source labels are `YOU`/`MEETING` and `你`/`会议`, history clamps to 3–10, a new session clears all prior rows, and stopped/degraded states render a non-technical privacy slate.

- [ ] **Step 2: Verify the tests fail**

Run:

```powershell
npx.cmd vitest run src/captions/CameraStage.test.tsx --maxWorkers=1
```

Expected: FAIL because `CameraStage` does not exist.

- [ ] **Step 3: Implement the stage state model**

Create a paired entry type:

```ts
interface CameraStageEntry {
  id: string;
  sessionId: string;
  sequence: number;
  sourceChannel: 'microphone' | 'system';
  en?: AudienceCaption;
  zh?: AudienceCaption;
}
```

Subscribe to `onAudienceCaption`, `onStatus`, `onSettings`, and `getSettings`. Merge projections by ID, discard suppressed entries, retain only rows with both projections, and clear state on a new `starting` session ID. Render a privacy slate unless the session is `running` or `degraded`.

- [ ] **Step 4: Add the route**

In `src/App.tsx`, render `<CameraStage />` when `surface=camera-stage`.

- [ ] **Step 5: Verify renderer tests pass**

Run:

```powershell
npx.cmd vitest run src/captions/CameraStage.test.tsx --maxWorkers=1
```

Expected: PASS.

### Task 2: Build the exact 16:9 camera-stage presentation

**Files:**
- Modify: `src/captions/CameraStage.tsx`
- Modify: `src/captions/CameraStage.test.tsx`
- Modify: `src/captions/captions.css`

- [ ] **Step 1: Add failing presentation assertions**

Assert the root uses `camera-stage`, the English section precedes the Chinese section, both have explicit language labels, and theme settings produce the expected semantic background/text CSS variables. Assert the stage contains no button, input, link, cost, credential, notice, or control-window text.

- [ ] **Step 2: Verify the tests fail**

Run:

```powershell
npx.cmd vitest run src/captions/CameraStage.test.tsx --maxWorkers=1
```

Expected: FAIL until the split presentation is implemented.

- [ ] **Step 3: Implement the stage CSS**

Use:

```css
.camera-stage {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: #000;
}
.camera-stage__audience {
  box-sizing: border-box;
  height: 50%;
  padding: 5vh 5vw;
}
```

Apply theme-specific English and Chinese colors through CSS variables. Use one fluid type scale based on `clamp()` and viewport units, compact older rows by age, preserve full opacity for the newest two rows, and disable reflow transitions under `prefers-reduced-motion`.

- [ ] **Step 4: Verify presentation tests pass**

Run:

```powershell
npx.cmd vitest run src/captions/CameraStage.test.tsx --maxWorkers=1
```

Expected: PASS.

### Task 3: Add the native camera-stage window

**Files:**
- Modify: `electron/captions/caption-window-manager.js`
- Modify: `electron/captions/overlay-layout.test.cjs`
- Modify: `electron/captions-main.js`

- [ ] **Step 1: Write failing window-manager tests**

Assert:

```js
const stage = manager.showCameraStage();
assert.equal(stage.options.width, 1920);
assert.equal(stage.options.height, 1080);
assert.equal(stage.options.transparent, false);
assert.equal(stage.options.frame, false);
assert.equal(stage.aspectRatio, 16 / 9);
```

Assert the stage is created lazily, re-used after hide/show, closes to hidden unless the app is quitting, receives both audience projections, and receives status/settings broadcasts. Assert overlay mode hides the stage and shows both overlay windows; virtual-camera mode hides overlays and shows the stage without calling the session manager.

- [ ] **Step 2: Verify the tests fail**

Run:

```powershell
node --test electron/captions/overlay-layout.test.cjs
```

Expected: FAIL because camera-stage methods do not exist.

- [ ] **Step 3: Implement the window-manager boundary**

Add:

```js
createCameraStageWindow()
showCameraStage()
hideCameraStage()
applyOutputMode(mode)
```

Create a non-transparent, frameless, resizable 1920×1080 window, call `setAspectRatio(16 / 9)`, keep it in the taskbar, deny navigation/window opening, and load `surface=camera-stage`. Publish both `projectForAudience(event, 'en')` and `projectForAudience(event, 'zh')` to the stage window.

- [ ] **Step 4: Trust the stage in security policies**

Include `cameraStageWindow` in Electron permission checks, while granting it no media capture APIs beyond the existing trusted-renderer set.

- [ ] **Step 5: Verify window-manager tests pass**

Run:

```powershell
node --test electron/captions/overlay-layout.test.cjs
```

Expected: PASS.

### Task 4: Persist output mode and expose control actions

**Files:**
- Modify: `electron/captions/settings-store.js`
- Modify: `electron/captions/caption-foundation.test.cjs`
- Modify: `electron/captions/register-caption-ipc.js`
- Modify: `electron/captions-preload.js`
- Modify: `src/electron.d.ts`
- Modify: `src/captions/types.ts`
- Modify: `src/captions/ControlApp.tsx`
- Modify: `src/captions/ControlApp.test.tsx`

- [ ] **Step 1: Write failing settings and IPC tests**

Require settings version 9 and:

```js
outputMode: 'overlays'
```

Accept only `overlays` and `virtual-camera`, normalizing unknown values to `overlays`. Test trusted IPC methods `captions:output-mode-set`, `captions:camera-stage-show`, and `captions:camera-stage-hide`.

- [ ] **Step 2: Write failing control-app tests**

Assert the Audience View card offers `On-screen captions` and `Virtual camera`. Selecting Virtual camera invokes `setOutputMode('virtual-camera')`, shows the OBS bridge explanation and `Open camera stage`, and does not invoke session stop. Selecting On-screen captions returns to the overlays.

- [ ] **Step 3: Verify focused tests fail**

Run:

```powershell
node --test electron/captions/caption-foundation.test.cjs electron/captions/meeting-record-ipc.test.cjs
npx.cmd vitest run src/captions/ControlApp.test.tsx --maxWorkers=1
```

Expected: FAIL because output-mode contracts do not exist.

- [ ] **Step 4: Implement settings, IPC, preload, and UI**

Add `outputMode: 'overlays' | 'virtual-camera'` to settings and bridge methods:

```ts
setOutputMode(mode: 'overlays' | 'virtual-camera'): Promise<Result<{ outputMode: string }>>;
showCameraStage(): Promise<Result<void>>;
hideCameraStage(): Promise<Result<void>>;
```

Render the selector and OBS instructions in the existing Audience View card. Persist the selection and apply it without stopping or restarting the caption session.

- [ ] **Step 5: Verify focused tests pass**

Run:

```powershell
node --test electron/captions/caption-foundation.test.cjs electron/captions/meeting-record-ipc.test.cjs
npx.cmd vitest run src/captions/ControlApp.test.tsx --maxWorkers=1
```

Expected: PASS.

### Task 5: Verify and package the W3-ready client

**Files:**
- Modify: `docs/windows/README.md`
- Modify: `docs/windows/virtual-camera.md`
- Modify: `docs/windows/validation-matrix.md`
- Create: `docs/windows/evidence/2026-07-30-w3-working-tree/README.md`

- [ ] **Step 1: Update documentation**

Mark the stage and output selector implemented, document exact window title and OBS Window Capture selection, and leave hardware/meeting-client checks unpassed until observed.

- [ ] **Step 2: Run full automated verification**

Run:

```powershell
npm.cmd run test:captions
npx.cmd vitest run --maxWorkers=1
npm.cmd run build
git diff --check
```

Expected: all tests and build pass with no whitespace errors.

- [ ] **Step 3: Rebuild and relaunch**

Stop only executables running under the project’s exact `out\Twinscript-win32-x64` path, run `npm.cmd run make`, and relaunch `twinscript.exe`. Verify every exact-path Electron process is responsive.

### Task 6: Install official OBS Studio and validate Virtual Camera

**Files:**
- Modify: `docs/windows/evidence/2026-07-30-w3-working-tree/README.md`

- [x] **Step 1: Download the official GitHub release**

Download `OBS-Studio-32.1.2-Windows-x64-Installer.exe` from the official `obsproject/obs-studio` GitHub release. Verify SHA-256:

```text
94d180c1fc481ccc307b95513f795d088d63ac4f61ad3253c2ac0d94d0844110
```

- [x] **Step 2: Install OBS Studio**

Run the verified installer interactively or silently with the vendor-supported option, then verify:

```powershell
& 'C:\Program Files\obs-studio\bin\64bit\obs64.exe' --version
```

Expected: OBS Studio 32.1.2 x64.

- [x] **Step 3: Configure and inspect the capture**

Create scene `Bilingual Captions`, use a 1920×1080 canvas/output at 30 fps, add a Window Capture source for the camera-stage window, fit it to canvas, and start OBS Virtual Camera.

- [x] **Step 4: Verify virtual-camera registration**

Confirm Windows enumerates `OBS Virtual Camera`. Capture a non-sensitive screenshot showing the stage fitted without transparency, clipping, control chrome, or private app state.

- [x] **Step 5: Record validation limits honestly**

Record automated and local OBS results. Keep Teams, Zoom, Chromium meeting enumeration/readability, language/audio scenarios, and the 60-minute soak as `NOT RUN` until actually observed. W3 is complete only when every validation-matrix row has direct evidence.

**Dirty-worktree constraint:** Preserve existing W2 changes and the staged deletion of `scripts/copy-ort-wasm.sh`. Do not stage, revert, or commit shared implementation files during this execution.
