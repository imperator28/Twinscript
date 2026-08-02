# Universal Glossary and Distinct Themes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task by task.

**Goal:** Replace meeting-type glossary selection with one universal engineering glossary, and offer exactly three clearly differentiated caption themes: Blueprint, Graphite, and Red / Blue.

**Architecture:** Keep the four legacy glossary datasets as private migration inputs, merge them into one public built-in configuration, and normalize every saved or incoming configuration ID to that universal configuration. Keep themes data-driven through the shared JSON catalog so the control UI and overlay use the same semantic tokens. Advance settings to version 8 so legacy glossary and theme IDs migrate without losing custom glossary entries.

**Tech Stack:** Electron, Node.js CommonJS, React, TypeScript, Vitest, Node test runner, CSS, Electron Forge.

---

## Task 1: Build and verify the universal glossary

**Files:**

- Modify: `electron/captions/glossary-config.js`
- Modify: `electron/captions/glossary-config.test.cjs`

**Step 1: Write failing catalog tests**

Add assertions that:

- the public built-in catalog contains exactly one configuration;
- its ID is `universal-engineering`;
- it includes representative terms from mechanical design, DFM, quality, and South China supplier meetings;
- normalized English/Chinese term pairs are unique;
- compiling any legacy configuration ID returns the universal ID while preserving custom terms and protected tokens.

Run:

```powershell
node --test electron/captions/glossary-config.test.cjs
```

Expected: FAIL because the catalog still exposes four meeting-type configurations.

**Step 2: Add a deterministic universal merge**

Keep the existing four datasets private as `LEGACY_GLOSSARY_CONFIGURATIONS`. Add a helper that merges them into:

```js
{
  id: 'universal-engineering',
  name: 'Universal engineering',
  description: 'Mechanical design, manufacturing, quality, tooling, and supplier terminology.',
  domains: [...],
  regions: [...],
  protectedTokens: [...],
  terms: [...]
}
```

Deduplicate by normalized English/Chinese pair. On collisions, keep the higher-priority row, union aliases, preserve `doNotTranslate` if either row requires it, and keep the maximum priority. Export only the one-item public catalog. Make `getBuiltinConfiguration` return the universal configuration for old, unknown, or current IDs.

**Step 3: Run focused tests**

Run:

```powershell
node --test electron/captions/glossary-config.test.cjs
```

Expected: PASS.

## Task 2: Migrate settings and replace the theme catalog

**Files:**

- Modify: `shared/caption-themes.json`
- Modify: `electron/captions/settings-store.js`
- Modify: `electron/captions/caption-foundation.test.cjs`
- Modify: `src/captions/types.ts`
- Modify: `src/captions/captionThemes.ts`

**Step 1: Write failing migration and theme tests**

Add assertions that:

- settings version is 8;
- defaults and migrated settings use `universal-engineering`;
- custom glossary content survives migration;
- the valid theme IDs are exactly `blueprint`, `graphite`, and `red-blue`;
- old IDs (`blue-air`, `steel`, `telemetry`) and unknown IDs migrate to `blueprint`;
- every text/background pair used by the catalog meets a 4.5:1 contrast ratio.

Run:

```powershell
node --test electron/captions/caption-foundation.test.cjs
```

Expected: FAIL against settings version 7 and the four-theme catalog.

**Step 2: Replace the shared theme catalog**

Use these primary panel colors:

- Blueprint: preserve current `#0D47A1` English and `#E3F2FD` Chinese cards.
- Graphite: `#30343B` English and `#D9DEE5` Chinese cards.
- Red / Blue: `#164E87` English and `#8B2635` Chinese cards.

Provide accessible semantic primary, secondary, accent, and border colors for each panel. Keep Blueprint first and default.

**Step 3: Advance settings migration**

Set `CURRENT_SETTINGS_VERSION` to 8. Default to the universal glossary. During reads and writes, compile old configuration IDs into `universal-engineering`, preserve `customGlossaryConfiguration`, and normalize removed theme IDs to Blueprint.

Update the TypeScript theme union to:

```ts
export type CaptionThemeId = 'blueprint' | 'graphite' | 'red-blue';
```

**Step 4: Run focused tests**

Run:

```powershell
node --test electron/captions/caption-foundation.test.cjs
```

Expected: PASS.

## Task 3: Simplify the control UI

**Files:**

- Modify: `src/captions/ControlApp.tsx`
- Modify: `src/captions/ControlApp.test.tsx`
- Modify: `src/captions/captions.css`

**Step 1: Write failing UI tests**

Replace the meeting-type selector test with assertions that:

- no meeting-type combobox is present;
- the card shows one `Engineering glossary` summary;
- built-in term and protected-token counts are visible;
- import, export, and Advanced custom controls remain available.

Replace the four-theme test with assertions for exactly Blueprint, Graphite, and Red / Blue, and verify selecting Red / Blue saves `captionTheme: 'red-blue'`.

Run:

```powershell
npx vitest run src/captions/ControlApp.test.tsx --maxWorkers=1
```

Expected: FAIL while the old selector and four choices remain.

**Step 2: Implement the simplified glossary card**

Remove the `Meeting type` select and configuration tags. Change the title to `Engineering glossary`, explain that the built-in vocabulary covers design, manufacturing, quality, tooling, and supplier meetings, and show one compact count line. Keep local import/export and Advanced custom-term behavior unchanged. Change helper text to say custom rows take priority over the built-in engineering glossary.

**Step 3: Implement the three-choice theme picker**

Render the three shared theme entries in one responsive row on normal desktop widths, falling back cleanly on narrow windows. Keep visible selected, hover, keyboard-focus, and disabled states.

**Step 4: Run focused UI tests**

Run:

```powershell
npx vitest run src/captions/ControlApp.test.tsx --maxWorkers=1
```

Expected: PASS.

## Task 4: Update overlay integration tests

**Files:**

- Modify: `electron/captions/overlay-layout.test.cjs`
- Modify: `src/captions/CaptionSurface.test.tsx`

**Step 1: Replace removed theme fixtures**

Change any `steel`, `telemetry`, or `blue-air` fixtures to `graphite` or `red-blue`. Assert that the native window receives the selected theme's background and that the caption surface exposes the correct semantic CSS variables for Red / Blue.

**Step 2: Run focused integration tests**

Run:

```powershell
node --test electron/captions/overlay-layout.test.cjs
npx vitest run src/captions/CaptionSurface.test.tsx --maxWorkers=1
```

Expected: PASS.

## Task 5: Document, verify, package, and relaunch

**Files:**

- Modify: `docs/windows/README.md`
- Modify: `docs/windows/validation-matrix.md`
- Modify: `docs/superpowers/specs/2026-07-30-universal-glossary-distinct-themes-design.md`

**Step 1: Update operator documentation**

Document the universal glossary, the three themes and their English/Chinese mapping, settings migration behavior, and the manual checks required for contrast, persistence, custom glossary preservation, and overlay readability. Mark the approved design as implemented and awaiting user validation.

**Step 2: Run complete verification**

Run:

```powershell
npm.cmd run test:captions
npx.cmd vitest run --maxWorkers=1
npm.cmd run build
git diff --check
```

Expected: all tests and build pass, with no whitespace errors.

**Step 3: Rebuild the Windows package**

Stop only running processes whose executable path is inside:

```text
C:\Users\jqian\Documents\Bilingual Meeting\out\Twinscript-win32-x64
```

Then run:

```powershell
npm.cmd run make
```

Expected: Electron Forge produces the unpacked client and Windows installer artifacts successfully.

**Step 4: Relaunch and verify the packaged client**

Launch:

```text
C:\Users\jqian\Documents\Bilingual Meeting\out\Twinscript-win32-x64\twinscript.exe
```

Verify the exact-path process is running and responsive. Hand the user a concise actual-testing checklist covering the universal glossary, the three distinct themes, migration/custom-term preservation, synced overlay sizing, focus behavior, and fresh-session transcript clearing.

**Dirty-worktree constraint:** Do not stage, revert, or commit shared implementation files during this execution. Preserve the user's existing W2 changes and the pre-existing staged deletion of `scripts/copy-ort-wasm.sh`.
