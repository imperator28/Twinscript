# Session and Audience Preview Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make session startup honor the selected audience output, add synchronized Preview/Hide preview behavior with Esc dismissal, and replace the launch card with one top-right Start/Stop and elapsed-time action pill.

**Architecture:** `CaptionWindowManager` remains authoritative for native window visibility and publishes a small visibility snapshot through the trusted IPC/preload boundary. `ControlApp` consumes that state to render one preview toggle and one session action pill, while `CameraStage` only forwards Esc through the restricted bridge. Preview visibility remains transient.

**Tech Stack:** Electron 40, Node.js CommonJS tests, React 19, TypeScript, Vitest, Testing Library, CSS.

**Dirty-worktree constraint:** Do not stage or commit during this plan. The index already contains the user's staged deletion of `scripts/copy-ort-wasm.sh`; preserve it and every unrelated W2/W3 change.

---

### Task 1: Make native output visibility authoritative

**Files:**
- Modify: `electron/captions/caption-window-manager.js`
- Test: `electron/captions/overlay-layout.test.cjs`

- [ ] **Step 1: Write failing visibility and selected-output tests**

Extend the fake browser window with `isVisible()`. Add tests requiring:

```js
assert.deepEqual(manager.previewVisibility(), {
  overlaysVisible: false,
  cameraStageVisible: false,
});

manager.outputMode = 'virtual-camera';
assert.deepEqual(manager.applySelectedOutput(), {
  overlaysVisible: false,
  cameraStageVisible: true,
});

manager.outputMode = 'overlays';
assert.deepEqual(manager.applySelectedOutput(), {
  overlaysVisible: true,
  cameraStageVisible: false,
});
```

Also assert that closing or hiding the camera stage and hiding either overlay publishes `captions:preview-visibility` to the control window.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="preview visibility|selected output" electron/captions/overlay-layout.test.cjs
```

Expected: FAIL because `previewVisibility()` and `applySelectedOutput()` do not exist.

- [ ] **Step 3: Implement the minimal native visibility contract**

Add:

```js
previewVisibility() {
  const overlaysVisible = AUDIENCES.every((audience) => {
    const window = this.captionWindows.get(audience);
    return window && !window.isDestroyed() && window.isVisible();
  });
  const cameraStageVisible = Boolean(
    this.cameraStageWindow &&
      !this.cameraStageWindow.isDestroyed() &&
      this.cameraStageWindow.isVisible(),
  );
  return { overlaysVisible, cameraStageVisible };
}

publishPreviewVisibility() {
  const snapshot = this.previewVisibility();
  this.broadcastControl('captions:preview-visibility', snapshot);
  return snapshot;
}

applySelectedOutput() {
  if (this.outputMode === 'virtual-camera') {
    this.hideAll({ notify: false });
    this.showCameraStage({ notify: false });
  } else {
    this.hideCameraStage({ notify: false });
    this.showAll({ notify: false });
  }
  return this.publishPreviewVisibility();
}
```

Allow `showAll`, `hideAll`, `showCameraStage`, and `hideCameraStage` to accept an internal `{ notify = true }` option. Register native `show`/`hide` listeners so close-to-hide and individual overlay close events synchronize the control. When `applySettings()` detects an actual output-mode change, call `applySelectedOutput()`; unrelated settings hydration must not reveal windows.

- [ ] **Step 4: Run the focused tests and verify GREEN**

```powershell
node --test --test-name-pattern="preview visibility|selected output|output-mode settings|camera stage is lazy" electron/captions/overlay-layout.test.cjs
```

Expected: all selected tests PASS.

### Task 2: Route session startup and expose visibility through IPC

**Files:**
- Modify: `electron/captions/register-caption-ipc.js`
- Modify: `electron/captions-preload.js`
- Modify: `src/electron.d.ts`
- Test: `electron/captions/meeting-record-ipc.test.cjs`

- [ ] **Step 1: Write failing IPC tests**

Update the harness with `applySelectedOutput()` and `previewVisibility()`. Assert successful session startup records `apply-selected-output` and never records `show-all`. Assert trusted `captions:preview-visibility-get` returns:

```js
{ overlaysVisible: false, cameraStageVisible: true }
```

- [ ] **Step 2: Run the IPC tests and verify RED**

```powershell
node --test --test-name-pattern="selected output|preview visibility" electron/captions/meeting-record-ipc.test.cjs
```

Expected: FAIL because startup still calls `showAll()` and no visibility getter exists.

- [ ] **Step 3: Implement the IPC and preload contract**

Change startup to:

```js
handle('captions:session-start', async (request) => {
  const result = await sessionManager.start(request);
  windows.applySelectedOutput();
  return result;
});
```

Register `captions:preview-visibility-get`, add `captions:preview-visibility` to `EVENT_CHANNELS`, and expose:

```js
getPreviewVisibility: () => invoke('captions:preview-visibility-get'),
onPreviewVisibility: (callback) =>
  subscribe('captions:preview-visibility', callback),
```

Define:

```ts
interface CaptionPreviewVisibility {
  overlaysVisible: boolean;
  cameraStageVisible: boolean;
}
```

Use it in the getter, subscription, and all four show/hide signatures in
`src/electron.d.ts`. Each show/hide IPC handler must return the confirmed
`CaptionPreviewVisibility` snapshot after applying its native action.

- [ ] **Step 4: Verify the IPC tests pass**

```powershell
node --test electron/captions/meeting-record-ipc.test.cjs
```

Expected: all tests PASS.

### Task 3: Hide the frameless camera stage with Esc

**Files:**
- Modify: `src/captions/CameraStage.tsx`
- Test: `src/captions/CameraStage.test.tsx`

- [ ] **Step 1: Write the failing keyboard test**

Add a `hideCameraStage` mock and:

```tsx
it('hides the frameless camera stage when Escape is pressed', () => {
  render(<CameraStage />);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(window.captions.hideCameraStage).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the test and verify RED**

```powershell
npx.cmd vitest run src/captions/CameraStage.test.tsx --maxWorkers=1
```

Expected: the new test FAILS because no keyboard listener exists.

- [ ] **Step 3: Add the minimal Escape listener**

Inside the existing effect, register and clean up:

```ts
const hideOnEscape = (event: KeyboardEvent) => {
  if (event.key === 'Escape') void window.captions.hideCameraStage();
};
window.addEventListener('keydown', hideOnEscape);
// cleanup: window.removeEventListener('keydown', hideOnEscape)
```

Do not add visible controls to the captured stage.

- [ ] **Step 4: Verify the camera-stage suite passes**

```powershell
npx.cmd vitest run src/captions/CameraStage.test.tsx --maxWorkers=1
```

Expected: all CameraStage tests PASS.

### Task 4: Add one synchronized Preview/Hide preview action

**Files:**
- Modify: `src/captions/ControlApp.tsx`
- Test: `src/captions/ControlApp.test.tsx`

- [ ] **Step 1: Write failing preview-state tests**

Extend the bridge harness with the getter and event listener. Require exactly one audience-preview action:

```tsx
expect(await screen.findByRole('button', { name: 'Preview' })).toBeVisible();
fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
expect(window.captions.showWindows).toHaveBeenCalledOnce();

act(() => previewVisibilityListener?.({
  overlaysVisible: true,
  cameraStageVisible: false,
}));
expect(screen.getByRole('button', { name: 'Hide preview' })).toBeVisible();
```

Repeat in virtual-camera mode and require `showCameraStage()` / `hideCameraStage()`. Add a rejected-IPC assertion that keeps the confirmed label and displays the error.

- [ ] **Step 2: Run the tests and verify RED**

```powershell
npx.cmd vitest run src/captions/ControlApp.test.tsx --maxWorkers=1
```

Expected: FAIL because the UI still renders one-way Show.

- [ ] **Step 3: Implement confirmed preview state**

Add:

```ts
const [previewVisibility, setPreviewVisibility] = useState({
  overlaysVisible: false,
  cameraStageVisible: false,
});
```

Subscribe to `onPreviewVisibility`, hydrate with `getPreviewVisibility()`, and derive selected visibility from `settings.outputMode`. Replace Show with one `Preview` / `Hide preview` button. Await the correct bridge call; update from the successful returned snapshot/event, otherwise call `setNotice(result.error.message)`.

- [ ] **Step 4: Verify the ControlApp tests pass**

```powershell
npx.cmd vitest run src/captions/ControlApp.test.tsx --maxWorkers=1
```

Expected: all ControlApp tests PASS.

### Task 5: Integrate Start/Stop and timer into the header pill

**Files:**
- Modify: `src/captions/ControlApp.tsx`
- Modify: `src/captions/captions.css`
- Test: `src/captions/ControlApp.test.tsx`

- [ ] **Step 1: Write failing session-action tests**

Require:

```tsx
const startAction = await screen.findByRole('button', { name: 'Start session' });
expect(startAction).toHaveClass('session-pill');
expect(screen.queryByText('Ready for a live meeting')).not.toBeInTheDocument();

act(() => statusListener?.({ state: 'running', sessionId: 'session-1' }));
act(() => metricsListener?.({ elapsedMs: 168_000 }));
expect(screen.getByRole('button', {
  name: /Stop session.*02:48/i,
})).toBeVisible();
```

Assert Starting and Stopping are disabled, Start retains credential/recovered-record guards, and clicking the live pill invokes stop.

- [ ] **Step 2: Run the tests and verify RED**

```powershell
npx.cmd vitest run src/captions/ControlApp.test.tsx --maxWorkers=1
```

Expected: FAIL because the pill is a `div` and the launch card owns Start/Stop.

- [ ] **Step 3: Implement the integrated action**

Replace the header pill with a real button. Derive:

```ts
const sessionActionLabel =
  operation === 'starting'
    ? 'Starting…'
    : operation === 'stopping'
      ? 'Stopping…'
      : active
        ? 'Stop session'
        : 'Start session';
```

When active, include a separator and `formatElapsed(metrics.elapsedMs)`. Route click to `stop()` when active and `start()` when idle. Remove the standalone launch-card JSX.

Update CSS so the pill is at least 44 px high, has clear hover/active feedback, keeps the red live dot and tabular timer, and does not shift as the timer changes.

- [ ] **Step 4: Run the focused renderer suite**

```powershell
npx.cmd vitest run src/captions/ControlApp.test.tsx src/captions/CameraStage.test.tsx --maxWorkers=1
```

Expected: both files PASS.

### Task 6: Full verification and implementation evidence

**Files:**
- Modify: `docs/windows/README.md`
- Modify: `docs/windows/validation-matrix.md`

- [ ] **Step 1: Run all automated checks**

```powershell
npm.cmd run test:captions
npx.cmd vitest run --maxWorkers=1
npm.cmd run build
git diff --check
```

Expected: every command exits 0 with no test failures or whitespace errors.

- [ ] **Step 2: Update progress documentation**

Record selected-output session routing, synchronized Preview/Hide preview, Esc dismissal, and the integrated session timer as implemented. Leave native interaction and meeting-client observations pending until exercised.

- [ ] **Step 3: Rebuild and validate without force-killing**

Close running clients only through normal UI or a graceful application-close path. Rebuild/package and manually confirm:

1. Virtual-camera startup shows no lower thirds.
2. Preview/Hide preview follows Esc.
3. The header reads Start session when idle and Stop session | timer when live.

Expected: no breakpoint dialog and no stale audience windows.

## Separate follow-up: Sokuji source cleanup

Do not combine upstream-source deletion with these behavior changes. First produce a removal manifest from `src/App.tsx`, `vite.config.ts`, runtime `require()` calls, package contents, and test imports. Preserve the reused `ModernAudioRecorder`, `LoopbackRecorder`, GTCRN path, and platform audio utilities until replacement or removal is proven. Delete only complete, unreachable dependency clusters in a separately approved plan, with build and package-size evidence before and after each cluster.
