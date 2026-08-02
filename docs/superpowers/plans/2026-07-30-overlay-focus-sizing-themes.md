# Overlay Focus, Synchronized Sizing, and Caption Themes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make W2 ready for operator testing by keeping paired captions focused until translation settles, synchronizing overlay height without resize feedback, starting each session with a clean overlay, and adding four validated paired themes.

**Architecture:** Aggregate caption completion is projected from the caption domain into both audience renderers. The renderer measures natural inner content, while `CaptionWindowManager` owns one shared automatic/manual height, generation control, caps, persistence, and native backgrounds. A shared theme catalog supplies validated semantic tokens to renderer and main process.

**Tech Stack:** Electron, React 18, TypeScript, CommonJS main-process modules, Vitest, Node test runner, Electron Forge/Squirrel.

---

## Task 1: Add the shared theme catalog and migrate settings

**Files:**

- Create: `shared/caption-themes.json`
- Modify: `electron/captions/settings-store.js`
- Modify: `electron/captions/caption-foundation.test.cjs`
- Modify: `src/captions/types.ts`

- [ ] Add failing settings tests for version 7 defaults, all four accepted IDs, invalid-ID fallback to `blueprint`, valid/null overlay heights, and invalid-height fallback.
- [ ] Run `node --test electron/captions/caption-foundation.test.cjs` and confirm the new assertions fail.
- [ ] Define the four approved themes with `id`, `label`, palette, and semantic English/Chinese surface, primary, secondary, accent, border, and native-background values.
- [ ] Raise settings version to 7 and add:

```js
captionTheme: 'blueprint',
captionOverlayHeight: null,
```

- [ ] Validate theme IDs against the catalog. Normalize overlay height to `null` or a finite integer within the supported panel range without replacing a valid requested height merely because the current display is smaller.
- [ ] Add `captionTheme` and `captionOverlayHeight` to renderer settings types.
- [ ] Re-run `node --test electron/captions/caption-foundation.test.cjs` and confirm it passes.

## Task 2: Project aggregate completion and implement the focus cohort

**Files:**

- Modify: `electron/captions/caption-domain.js`
- Modify: `electron/captions/caption-foundation.test.cjs`
- Modify: `src/captions/types.ts`
- Modify: `src/captions/CaptionSurface.tsx`
- Modify: `src/captions/CaptionSurface.test.tsx`
- Modify: `src/captions/captions.css`

- [ ] Add a failing domain test proving both audience projections expose the same `settled` value while their target statuses differ.
- [ ] Add failing renderer tests proving all in-flight rows and the two newest settled rows use `is-focused`, the third-newest settled row uses `is-history`, and multiple in-flight rows are retained.
- [ ] Add failing renderer tests proving a new nonempty `starting.sessionId` clears prior rows and late prior-session captions are ignored.
- [ ] Run the focused Node and Vitest tests and confirm the new assertions fail.
- [ ] Project:

```js
settled: event.status === 'final' || event.status === 'failed'
```

- [ ] Retain the configured number of settled rows plus every unsuppressed in-flight row. Derive the focus IDs from all in-flight rows plus the two newest settled rows.
- [ ] Track the active session boundary from status events. Clear on a different `starting` session and reject audience events from a nonmatching session afterward.
- [ ] Replace age-only inline styling and `:last-child` enlargement with semantic `is-focused`/`is-history` classes. Keep focused rows equal in type size and opacity; preserve a readable opacity floor for history.
- [ ] Re-run the focused tests and confirm they pass.

## Task 3: Make overlay geometry use one balanced shared height

**Files:**

- Modify: `electron/captions/overlay-layout.js`
- Modify: `electron/captions/overlay-layout.test.cjs`

- [ ] Replace independent-height expectations with failing tests that require equal English/Chinese heights.
- [ ] Add failing tests for a stacked pair cap of 45% including the inter-panel gap and a side-by-side cap of 33%.
- [ ] Preserve coverage for taskbar offsets, negative-coordinate monitors, small work areas, bottom anchoring, and width/layout selection.
- [ ] Run `node --test electron/captions/overlay-layout.test.cjs` and confirm the new tests fail.
- [ ] Change `computeOverlayBounds` to accept `sharedHeight`, clamp it once per layout, and give both panels that height.
- [ ] Ensure stacked geometry computes:

```js
maxPanelHeight = Math.floor((workArea.height * 0.45 - gap) / 2)
```

and side-by-side geometry computes:

```js
maxPanelHeight = Math.floor(workArea.height * 0.33)
```

with existing minimum/work-area safety retained.
- [ ] Re-run `node --test electron/captions/overlay-layout.test.cjs` and confirm it passes.

## Task 4: Centralize auto/manual sizing and theme backgrounds in the window manager

**Files:**

- Modify: `electron/captions/caption-window-manager.js`
- Modify: `electron/captions/overlay-layout.test.cjs`
- Modify: `electron/captions-main.js`
- Modify: `electron/captions/register-caption-ipc.js`
- Modify: `electron/captions/meeting-record-ipc.test.cjs`
- Modify: `electron/captions-preload.js`
- Modify: `src/electron.d.ts`

- [ ] Add failing manager tests for larger-of-two natural heights, stale-generation rejection, 250 ms single-peer fallback, manual resize synchronization from either audience, programmatic resize guarding, debounced persistence, history reset, and native background updates.
- [ ] Add failing IPC tests for required integer generation, stale generation handling, wrong audience/sender rejection, and history/theme settings side effects.
- [ ] Run the two focused Node suites and confirm the new assertions fail.
- [ ] Construct `SettingsStore` before `CaptionWindowManager`, pass it into the manager, and remove duplicate initialization.
- [ ] Store `autoSizeGeneration`, per-audience measurements, shared automatic height, optional requested manual height, and a per-window programmatic-resize guard.
- [ ] Implement `reportContentHeight(audience, height, generation)`. Ignore old generations, use the maximum after both current reports, and schedule a 250 ms fallback from the first report.
- [ ] Listen to user resize events, adopt the dragged window height as manual, apply it to the peer immediately, keep the layout bottom-anchored, and debounce `captionOverlayHeight` persistence. Do not overwrite the stored requested height when display clamping applies.
- [ ] Implement a history-change reset that clears manual height, increments generation, clears measurements, broadcasts current generation, and returns to automatic sizing.
- [ ] Extend preload/typing/IPC payloads to `{ audience, height, generation }` with finite bounded-height and nonnegative-integer-generation validation.
- [ ] Apply the selected theme's opaque audience native background at creation and on settings changes.
- [ ] Re-run the two focused Node suites and confirm they pass.

## Task 5: Measure natural content and expose paired themes in the renderer

**Files:**

- Modify: `src/captions/CaptionSurface.tsx`
- Modify: `src/captions/CaptionSurface.test.tsx`
- Modify: `src/captions/ControlApp.tsx`
- Modify: `src/captions/ControlApp.test.tsx`
- Modify: `src/captions/captions.css`

- [ ] Add failing surface tests proving ResizeObserver targets an inner content wrapper, reports total natural height with the current generation, and applies the correct semantic tokens for each audience.
- [ ] Add failing control tests proving four paired previews render, Blueprint is selected by default, and clicking a theme persists its ID.
- [ ] Run the two focused Vitest files and confirm the new assertions fail.
- [ ] Add an inner natural-content wrapper inside the scroll viewport and observe it instead of `.caption-roll`.
- [ ] Report the wrapper's natural block size plus fixed surface chrome with the current generation. Reset observation when history/generation changes.
- [ ] Load semantic theme values from the shared catalog, expose them as CSS custom properties on each caption surface, and retain explicit language labels.
- [ ] Add four paired theme buttons to the existing Overlay settings card, with accessible selected state, English/Chinese swatches, and immediate `saveSettings({ captionTheme: id })`.
- [ ] Keep reduced-motion behavior and avoid vertical focus-state animation.
- [ ] Re-run the two focused Vitest files and confirm they pass.

## Task 6: Integrate, document, package, and prepare operator validation

**Files:**

- Modify: `docs/windows/README.md`
- Modify: `docs/windows/validation-matrix.md`
- Modify: `docs/windows/evidence/` W2 evidence files as appropriate
- Modify: `docs/superpowers/specs/2026-07-30-overlay-focus-sizing-themes-design.md`

- [ ] Run `npm.cmd run test:captions`.
- [ ] Run `npx.cmd vitest run --maxWorkers=1`.
- [ ] Run `npm.cmd run build`.
- [ ] Run `git diff --check`.
- [ ] Update Windows progress/evidence and the actual-testing checklist with focus under translation lag, two-row settled focus, multiple in-flight rows, resize synchronization/persistence, Visible history auto-sizing, fresh sessions, layouts/scales/monitors, and all four themes.
- [ ] Mark the design spec implemented and awaiting operator validation.
- [ ] Run `npm.cmd run make` and confirm a fresh Squirrel installer is produced at `out/make/squirrel.windows/x64/Twinscript-0.1.0 Setup.exe`.
- [ ] Launch the freshly packaged client, verify its process remains alive, and hand the operator a concise checklist of the behaviors that require actual desktop testing.
