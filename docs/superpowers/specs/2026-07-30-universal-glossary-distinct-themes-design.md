# Universal glossary and distinct caption themes

Date: 2026-07-30  
Status: approved design, awaiting written-spec review

## Purpose

Reduce two configuration choices that currently create work without helping
the meeting operator:

1. replace four overlapping meeting-type glossaries with one universal
   engineering glossary; and
2. replace four visually similar blue/cyan themes with three clearly different
   paired themes.

The change must preserve custom glossary imports, protected tokens, request
budgeting, existing meeting records, and live theme updates.

## Universal engineering glossary

### Product model

The product exposes one built-in configuration:

```text
id: universal-engineering
name: Engineering glossary
```

It combines the terms, aliases, protected tokens, domains, and regions from
the existing Mechanical & Product Design, Manufacturing & DFM, Manufacturing
Engineering & Quality, and South China Tooling & Supplier Meetings
configurations.

Compilation deduplicates terms by their normalized English/Chinese key while
preserving all unique aliases. When duplicate entries differ, the higher
priority wins and missing aliases are merged into that row. Protected tokens
are deduplicated case-insensitively.

The existing per-request selection remains bounded to the most relevant 16
rows and 800 prompt characters, so a larger stored glossary does not flood
OpenAI requests.

### Migration and compatibility

Settings move to the next schema version. Every built-in legacy
`glossaryConfigurationId` migrates to `universal-engineering`. A valid imported
custom configuration remains attached as an override and is recompiled
against the universal base.

Meeting records continue storing `glossaryConfigurationId`; new records use
`universal-engineering`. Old records remain readable without rewriting their
saved manifests.

### Interface

The Meeting glossary card removes:

- the Meeting type label and select menu;
- the selected-configuration description and domain/region tags; and
- wording that asks the operator to choose a meeting type.

It shows one compact summary:

```text
Engineering glossary
<stored count> built-in terms · <protected count> protected tokens
```

Import glossary and Advanced custom terms/protected tokens remain. Custom
entries continue to take priority over built-in entries. Export produces the
portable universal-plus-custom configuration.

## Caption themes

### Theme set

Only three paired themes remain:

| ID | Label | English surface | Chinese surface |
| --- | --- | --- | --- |
| `blueprint` | Blueprint | `#0D47A1`, white text | `#E3F2FD`, dark text |
| `graphite` | Graphite | `#30343B`, white text | `#D9DEE5`, dark text |
| `red-blue` | Red / Blue | `#164E87`, white text | `#8B2635`, white text |

Blueprint is unchanged and remains the default. Red / Blue maps English to
blue and Chinese to red, matching the original audience identity.

Each theme retains semantic primary, secondary, accent, border, and native
window-background tokens. All primary text/background pairs must meet WCAG AA
contrast for normal text.

### Migration

Existing `blueprint` selections remain unchanged. Removed `blue-air`, `steel`,
and `telemetry` selections migrate to Blueprint. Unknown IDs also normalize to
Blueprint.

### Interface

The theme picker renders three equal choices in one row when space permits,
wrapping responsively on narrow windows. Each choice shows:

- the theme name;
- a paired English/Chinese swatch;
- a visible selected border; and
- `aria-pressed` state.

Selection updates the control preview, both overlays, and both native window
backgrounds immediately and persists across restart.

## Error handling

- Missing or invalid glossary IDs normalize to `universal-engineering`.
- Invalid theme IDs normalize to Blueprint.
- A malformed imported glossary still fails through the existing validation
  path and does not replace the active configuration.
- Duplicate built-in entries cannot increase the request row/character limits.
- Existing records with legacy glossary IDs remain displayable.

## Test strategy

### Automated

- The built-in catalog exposes exactly one universal configuration.
- Universal compilation includes representative terms and aliases from all
  four legacy configurations without duplicate normalized rows.
- Legacy settings migrate while custom overrides survive.
- Request context remains within 16 rows and 800 characters.
- Theme validation accepts exactly Blueprint, Graphite, and Red / Blue.
- Removed and unknown theme IDs normalize to Blueprint.
- Every primary theme pair meets the contrast floor.
- The control app has no Meeting type combobox, shows one glossary summary,
  and retains Import and Advanced controls.
- The control app renders three theme choices and persists Red / Blue.
- Overlay and native window backgrounds use the selected audience tokens.

### Operator validation

- Confirm the glossary card has no meeting-type decision.
- Import a custom glossary, save an advanced override, and verify both remain
  active in a live caption.
- Compare Blueprint, Graphite, and Red / Blue over bright and dark underlying
  applications.
- Restart the app and confirm the selected theme persists.

## Out of scope

- Removing custom glossary import/export.
- Changing the 16-row/800-character request budget.
- Editing old meeting-record manifests.
- Arbitrary color pickers or user-authored theme colors.
