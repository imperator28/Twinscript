# Meeting Glossary Configuration Implementation Plan

Date: 2026-07-30
Design: `docs/superpowers/specs/2026-07-30-meeting-glossary-config-design.md`

## Outcome

Replace the freeform-first glossary with an offline, shareable configuration
workflow. Ship four engineering configurations, always preserve common English
product-development tokens such as T1, T2, EVT, DVT, and PVT, and keep native
import/export available on macOS and Windows.

## Architecture

1. Add a main-process glossary domain module as the single source of truth for
   built-in packs, validation, parsing, merging, migration, compilation, and
   export.
2. Persist only sanitized configuration data through `SettingsStore`; always
   recompute the compiled 40-term runtime glossary and protected-token list.
3. Expose narrow request/response IPC methods for listing packs and opening
   native import/export dialogs. Never expose filesystem paths or raw Node APIs
   to the renderer.
4. Keep the renderer configuration-first. Template selection is the primary
   control; import/export are secondary actions; manual overrides live in a
   native disclosure element.
5. Supply protected tokens both to GPT Live Transcribe keywords and to the
   normalization prompt. Canonicalize token case and retry one final
   normalization response when a source token is missing.

## Tasks

### 1. Glossary domain and built-in data

- Add the core protected product-development vocabulary.
- Add Mechanical & Product Design, Manufacturing & DFM, Manufacturing
  Engineering & Quality, and South China Tooling & Supplier packs.
- Implement sanitization, duplicate merging, priority ordering, active-term
  compilation, and JSON/CSV/TSV/TXT parsing.
- Add round-trip export and actionable parse errors.

### 2. Persistence and migration

- Bump caption settings to version 5.
- Add selected configuration, custom overlay, protected tokens, and stored-term
  count.
- Migrate legacy `en = zh` rows into a custom overlay without losing terms.
- Recompile derived runtime fields on every glossary-related settings change.

### 3. Secure desktop bridge

- Add list/import/export IPC handlers with sender validation.
- Use native open/save dialogs and extension allowlists.
- Return structured success, cancellation, rejected-row, and duplicate counts.
- Add typed preload methods without exposing `ipcRenderer`.

### 4. Configuration-first settings UI

- Replace the existing textarea-first card with a labelled template selector,
  description, tags, and active/stored counts.
- Add Import glossary and Export configuration actions.
- Put custom term and custom protected-token editing in an Advanced disclosure.
- Disable changes during a live session and announce import/save errors.

### 5. Runtime preservation

- Add protected tokens to transcription keywords.
- Add a concise protected-token instruction to the normalizer.
- Canonicalize recognized protected-token casing.
- Retry a final normalization once if a token present in the source is absent
  from the target, while accounting for all retry usage.

### 6. Verification

- Unit-test all parsers, validation, merging, limits, built-in pack integrity,
  migration, and export round trips.
- Test protected-token transcription context and normalizer retry/canonical
  behavior.
- Test template selection, native import/export calls, progressive disclosure,
  counts, and live-session disabled states.
- Run caption backend tests, focused renderer tests, TypeScript production
  build, Electron package, and diff checks.
- Review the final UI against Emil, Apple, and UI/UX Pro Max guidance.

## Scope boundaries

- No cloud glossary synchronization.
- No PDF, drawing, BOM, or Word extraction.
- No arbitrary user-defined regex replacement.
- No change to translation model selection or validation tooling.
- No bot or virtual-camera work in this implementation.
