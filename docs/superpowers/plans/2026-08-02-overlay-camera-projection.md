# Overlay and Camera Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve expandable caption history, treat manual overlay height as a floor, and make both camera layouts fill the 16:9 stage with history-aware typography.

**Architecture:** React renderers retain a bounded caption buffer and derive the visible slice. Electron owns synchronized geometry using `max(manual floor, natural content)`. The existing `layout` setting drives desktop overlays, preview, and offscreen camera output on Windows and macOS.

**Tech Stack:** Electron 40, React 19, TypeScript, CSS variables, Node test runner, Vitest, Testing Library.

---

## File map

- Modify `src/captions/CaptionSurface.tsx`: separate retained and visible cohorts.
- Modify `src/captions/CaptionSurface.test.tsx`: prove history expansion.
- Modify `electron/captions/caption-window-manager.js`: manual-height floor.
- Modify `electron/captions/register-caption-ipc.js`: preserve the floor on history changes.
- Modify `electron/captions/overlay-layout.test.cjs` and `meeting-record-ipc.test.cjs`: geometry coverage.
- Modify `src/captions/CameraStage.tsx` and `captions.css`: shared layout and density.
- Modify `src/captions/CameraStage.test.tsx`: stage behavior.
- Modify `src/captions/ControlApp.tsx` and `ControlApp.test.tsx`: layout control in camera mode.
- Modify `docs/windows/validation-matrix.md`: revised operator checks.

### Task 1: Retain history independently of the visible slice

**Files:**
- Modify: `src/captions/CaptionSurface.tsx:5-128`
- Test: `src/captions/CaptionSurface.test.tsx`

- [ ] **Step 1: Write a failing history-expansion test**

```tsx
it('reveals retained captions when visible history increases', async () => {
  render(<CaptionSurface audience="en" />);
  const caption = (sequence: number): AudienceCaption => ({
    id: `line-${sequence}`, sessionId: 'session', sequence,
    sourceChannel: 'microphone', sourceText: `Source ${sequence}`,
    sourceLanguage: 'en', audience: 'en', text: `Line ${sequence}`,
    status: 'final', settled: true, revision: 1, passthrough: true,
    sourceStartedAt: sequence,
  });
  act(() => settingsListener?.({ captionHistoryEntries: 3 }));
  for (let sequence = 1; sequence <= 10; sequence += 1) {
    act(() => audienceListener?.(caption(sequence)));
  }
  expect(screen.queryByText('Line 1')).not.toBeInTheDocument();
  act(() => settingsListener?.({ captionHistoryEntries: 10 }));
  expect(await screen.findByText('Line 1')).toBeInTheDocument();
});
```

- [ ] **Step 2: Verify the test fails**

Run `npx vitest run src/captions/CaptionSurface.test.tsx`.

Expected: FAIL because state was pruned to three settled rows.

- [ ] **Step 3: Implement separate retention and visibility helpers**

```tsx
const MAX_RETAINED_SETTLED = 10;

export function retainCaptionBuffer(captions: AudienceCaption[]) {
  const ordered = [...captions].sort((a, b) => a.sequence - b.sequence);
  const settled = ordered.filter((caption) => caption.settled)
    .slice(-MAX_RETAINED_SETTLED);
  const inFlight = ordered.filter((caption) => !caption.settled);
  return [...settled, ...inFlight].sort((a, b) => a.sequence - b.sequence);
}

export function visibleCaptions(captions: AudienceCaption[], limit: number) {
  const ordered = [...captions].sort((a, b) => a.sequence - b.sequence);
  const settled = ordered.filter((caption) => caption.settled).slice(-limit);
  const inFlight = ordered.filter((caption) => !caption.settled);
  return [...settled, ...inFlight].sort((a, b) => a.sequence - b.sequence);
}
```

Use `retainCaptionBuffer(next)` only for caption events. Settings events update
`historyEntries` without rewriting caption state. Render
`visibleCaptions(captions, historyEntries)`.

- [ ] **Step 4: Run and verify the renderer test**

Run `npx vitest run src/captions/CaptionSurface.test.tsx`.

Expected: PASS.

- [ ] **Step 5: Check the focused diff**

Run `git diff --check -- src/captions/CaptionSurface.tsx src/captions/CaptionSurface.test.tsx`.

Expected: no output. If commits are authorized, commit only these files with
`fix: retain expandable caption history`.

### Task 2: Make manual overlay height a floor

**Files:**
- Modify: `electron/captions/caption-window-manager.js:527-633`
- Modify: `electron/captions/register-caption-ipc.js:165-184`
- Test: `electron/captions/overlay-layout.test.cjs`
- Test: `electron/captions/meeting-record-ipc.test.cjs`

- [ ] **Step 1: Write failing floor tests**

```js
test('content grows above manual height and returns only to the floor', () => {
  const { manager, created } = managerHarness({ captionOverlayHeight: 210 });
  manager.show();
  manager.reportContentHeight('en', 320, manager.autoSizeGeneration);
  manager.reportContentHeight('zh', 300, manager.autoSizeGeneration);
  assert.equal(created[0].lastBounds.height, 320);
  assert.equal(created[1].lastBounds.height, 320);
  manager.reportContentHeight('en', 160, manager.autoSizeGeneration);
  manager.reportContentHeight('zh', 170, manager.autoSizeGeneration);
  assert.equal(created[0].lastBounds.height, 210);
  assert.equal(created[1].lastBounds.height, 210);
});

test('history generation reset preserves the manual floor', () => {
  const { manager } = managerHarness({ captionOverlayHeight: 240 });
  const next = manager.resetContentMeasurements();
  assert.equal(manager.manualHeight, 240);
  assert.equal(next.captionOverlayHeight, 240);
});
```

- [ ] **Step 2: Verify the tests fail**

Run `node --test electron/captions/overlay-layout.test.cjs electron/captions/meeting-record-ipc.test.cjs`.

Expected: FAIL because manual mode ignores measurements and history clears the
stored height.

- [ ] **Step 3: Implement effective height**

```js
effectiveHeight() {
  const candidates = [this.manualHeight, this.automaticHeight]
    .filter((height) => height !== null);
  return candidates.length ? Math.max(...candidates) : null;
}
```

Update `applyCurrentMeasurements()` even when `manualHeight` exists. After the
current-generation reports are complete, apply layout unconditionally. Pass
`effectiveHeight()` into overlay geometry.

- [ ] **Step 4: Preserve the floor during history changes**

Replace `resetAutoSize()` with `resetContentMeasurements()`:

```js
resetContentMeasurements() {
  this.clearFallbackTimer();
  this.automaticHeight = null;
  this.contentMeasurements.clear();
  this.autoSizeGeneration += 1;
  this.applyLayout(this.layout);
  return this.settingsStore?.get?.() || {
    captionOverlayHeight: this.manualHeight,
  };
}
```

In `register-caption-ipc.js`, call that method when history changes; do not set
`captionOverlayHeight` to null.

- [ ] **Step 5: Run main-process tests**

Run `npm run test:captions`.

Expected: all Node caption tests PASS.

- [ ] **Step 6: Check the geometry diff**

Run `git diff --check -- electron/captions/caption-window-manager.js electron/captions/register-caption-ipc.js electron/captions/overlay-layout.test.cjs electron/captions/meeting-record-ipc.test.cjs`.

Expected: no output. If authorized, commit with `fix: preserve overlay height floor`.

### Task 3: Apply shared layout and density to the camera stage

**Files:**
- Modify: `src/captions/CameraStage.tsx:29-199`
- Modify: `src/captions/captions.css:283-344`
- Test: `src/captions/CameraStage.test.tsx`

- [ ] **Step 1: Write failing layout tests**

```tsx
it('uses shared side-by-side layout and history density', async () => {
  render(<CameraStage />);
  act(() => settingsListener?.({
    layout: 'side-by-side',
    captionHistoryEntries: 10,
    captionTheme: 'blueprint',
  }));
  const stage = await screen.findByRole('main');
  expect(stage).toHaveClass('camera-stage--side-by-side');
  expect(stage).toHaveStyle({ '--stage-history-count': '10' });
});
```

Add a second assertion that invalid layout values use stacked.

- [ ] **Step 2: Verify the tests fail**

Run `npx vitest run src/captions/CameraStage.test.tsx`.

Expected: FAIL because CameraStage ignores layout.

- [ ] **Step 3: Store normalized layout and density**

```tsx
const [layout, setLayout] = useState<CaptionSettings['layout']>('stacked');
setLayout(settings.layout === 'side-by-side' ? 'side-by-side' : 'stacked');
```

Render class `camera-stage--${layout}` and variables:

```tsx
'--stage-history-count': String(historyEntries),
'--stage-density': String((historyEntries - 3) / 7),
```

- [ ] **Step 4: Replace fixed half-height CSS**

```css
.camera-stage { display: grid; }
.camera-stage--stacked { grid-template: repeat(2, minmax(0, 1fr)) / 1fr; }
.camera-stage--side-by-side { grid-template: 1fr / repeat(2, minmax(0, 1fr)); }
.camera-stage__audience { min-width: 0; min-height: 0; height: auto; }
.camera-stage__history { height: calc(100% - 5vh); }
.camera-stage__entry {
  margin-block: calc(.35vh - var(--stage-density) * .22vh);
  font-size: clamp(22px, calc(3vw - var(--stage-density) * 1.15vw), 50px);
}
.camera-stage--side-by-side .camera-stage__entry {
  grid-template-columns: minmax(5rem, 6vw) 1fr;
  font-size: clamp(20px, calc(2.35vw - var(--stage-density) * .8vw), 42px);
}
```

- [ ] **Step 5: Run stage and surface tests**

Run `npx vitest run src/captions/CameraStage.test.tsx src/captions/CaptionSurface.test.tsx`.

Expected: PASS.

### Task 4: Keep layout controls visible in camera mode

**Files:**
- Modify: `src/captions/ControlApp.tsx:903-945`
- Test: `src/captions/ControlApp.test.tsx`

- [ ] **Step 1: Write a failing camera-mode control test**

```tsx
it('keeps projection layout controls in virtual-camera mode', async () => {
  render(<ControlApp />);
  fireEvent.click(await screen.findByRole('button', { name: 'Virtual camera' }));
  expect(screen.getByRole('button', { name: 'Stacked' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Side by side' })).toBeVisible();
});
```

- [ ] **Step 2: Verify it fails**

Run `npx vitest run src/captions/ControlApp.test.tsx`.

Expected: FAIL because the segmented control is overlays-only.

- [ ] **Step 3: Move the existing control outside the output conditional**

Render the Stacked/Side by side buttons after the output selector. Keep only
the native-camera or OBS note conditional.

- [ ] **Step 4: Run the renderer suite**

Run `npx vitest run`.

Expected: all Vitest tests PASS.

### Task 5: Verify projection behavior and document manual checks

**Files:**
- Modify: `docs/windows/validation-matrix.md`

- [ ] **Step 1: Add exact Windows and macOS manual sequences**

Document:

```text
manual height -> history 3 -> history 10 -> history 3
stacked preview -> side-by-side preview -> Escape -> reopen
virtual-camera selected -> desktop overlays remain hidden
```

Expected: equal panels, growth above the floor, no automatic shrink below the
floor, explicit drag-to-smaller respected, and full-frame stage layouts.

- [ ] **Step 2: Run the automated gate**

```powershell
npm run test:captions
npx vitest run
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 3: Record the checkpoint**

Run `git diff --check`. Record Windows results and leave macOS manual items
pending until run on actual macOS hardware.
