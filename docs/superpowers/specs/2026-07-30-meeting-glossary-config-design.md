# Meeting Glossary Configuration Design

Date: 2026-07-30
Status: Approved for implementation
Scope: macOS Phase 1, structured for later Windows parity

## Problem

The current Meeting glossary is a freeform textarea. It works for a few terms,
but it makes recurring engineering meetings slow to configure, difficult to
share, and easy to configure inconsistently.

The application needs reusable meeting configurations that provide the correct
English and Simplified Chinese terminology for mechanical design,
manufacturing, manufacturing engineering, and South China supplier discussions.
Users must also be able to import and export their own terminology without
sending the source file to a new service.

## Goals

- Replace manual-first glossary setup with a meeting-configuration selector.
- Ship useful built-in configurations for common engineering meetings.
- Include canonical terminology and Guangdong/Shenzhen/Dongguan shop-floor
  aliases where the meanings are sufficiently established.
- Import `.json`, `.csv`, `.tsv`, and `.txt` glossary files locally.
- Export a versioned JSON configuration that is portable between macOS and the
  later Windows client.
- Preserve manual editing as an advanced escape hatch.
- Keep the active glossary bounded so it does not silently increase prompt cost
  or dilute terminology relevance.

## Non-goals

- Extracting terminology from drawings, PDFs, BOMs, or Word documents.
- Synchronizing configurations through a cloud account.
- Managing a company-wide glossary service.
- Automatically translating an arbitrary imported monolingual term list.
- Changing the Compare tab or the model evaluation pipeline.

## User experience

The Engineering Terms card becomes a configuration-first workflow:

1. Choose one meeting configuration.
2. Review its description, region/domain tags, and active term count.
3. Optionally import a glossary file. Imported terms overlay the selected
   built-in configuration without destroying it.
4. Export the resulting configuration as JSON for another computer.
5. Open Advanced editing only when an individual term needs correction.
6. Save the configuration.

The selector is available before a session and disabled while a live session is
running, matching the existing model-profile behavior. The active configuration
name remains visible during a session.

Import and export actions use explicit text labels and native file controls.
Success and validation failures appear in the existing notice region.

## Built-in configurations

Each built-in configuration contains at most 40 ordered, high-value terms. This
matches the current normalization limit in `glossaryPrompt()` and avoids the
misleading state where saved terms after entry 40 are never sent to the
normalizer.

### Mechanical & Product Design

Mechanical architecture, drawing review, CAD changes, dimensions, GD&T,
fasteners, fits, materials, surfaces, assembly, and tolerance stack-up.

### Manufacturing & DFM

Machining, sheet metal, stamping, casting, extrusion, joining, finishing,
tool access, draft, undercuts, wall thickness, yield, takt time, and process
capability.

### Manufacturing Engineering & Quality

Process flow, work instructions, fixtures, first-article inspection, control
plans, incoming/in-process/outgoing inspection, nonconformance, corrective
action, rework, scrap, yield, and pilot production.

### South China Tooling & Supplier Meetings

Injection-mould tooling, mould trials, supplier timing, and regional
Guangdong/Shenzhen/Dongguan vocabulary. Canonical terms remain the saved
English/Chinese pair; regional expressions are stored as aliases.

Representative alias mappings include:

| English | Canonical Chinese | Regional aliases |
| --- | --- | --- |
| injection-moulded part | 注塑件 | 啤件, 啤塑件 |
| flash | 飞边 | 批锋, 披锋 |
| slide / slider | 滑块 | 行位 |
| EDM electrode | 电火花电极 | 铜公, 铜工 |
| mould polishing | 模具抛光 | 省模 |
| mould spotting and fitting | 合模研配 | 飞模, 配模 |
| injection moulding machine | 注塑机 | 啤机 |
| sprue and runner | 主流道和流道 | 水口 |

Regional aliases are not treated as universal Chinese terminology. Their
configuration description explicitly identifies them as South China
shop-floor usage.

## Sources and terminology policy

Canonical mould terminology is anchored to:

- GB/T 8845-2017, *Dies and moulds—Terminology*:
  <https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=274DC464B652CFA1D71A29FAB9289DA5>
- ISO 12165:2019, *Tools for moulding—Components ... List of equivalent terms
  and symbols*: <https://www.iso.org/standard/75669.html>

Regional aliases are cross-checked against multiple industry sources, including
the mould terminology collection published by the Zhejiang Mould Industry
Association: <https://www.zmia.org.cn/4/31413?page=4>.

Every built-in entry must meet one of these conditions:

- standardized or broadly established technical terminology; or
- clearly labelled regional terminology with a canonical equivalent.

Ambiguous shop terms are excluded rather than guessed. English output uses
international engineering terminology, not a literal transliteration of the
regional alias.

## Portable configuration schema

JSON is the canonical shareable format:

```json
{
  "schemaVersion": 1,
  "id": "south-china-tooling",
  "name": "South China Tooling & Supplier Meetings",
  "description": "Injection-mould tooling and supplier terminology used in Guangdong manufacturing meetings.",
  "regions": ["Guangdong", "Shenzhen", "Dongguan"],
  "domains": ["tooling", "injection-moulding", "supplier"],
  "terms": [
    {
      "en": "flash",
      "zh": "飞边",
      "aliases": ["批锋", "披锋"],
      "doNotTranslate": false,
      "priority": 5
    }
  ]
}
```

### Validation

- `schemaVersion` must equal `1`.
- `name` is required and limited to 80 characters.
- A file may contain up to 500 stored terms.
- `en` and `zh` are required and limited to 120 characters each.
- `aliases` contains at most 10 strings of 120 characters.
- `priority` is an integer from 1 through 5 and defaults to 3.
- Unknown properties are ignored during import and omitted during export.
- HTML and control characters are stripped from displayed metadata.

## Additional import formats

### CSV and TSV

The first row is:

```text
en,zh,aliases,doNotTranslate,priority
```

Aliases use a pipe separator:

```text
flash,飞边,批锋|披锋,false,5
```

### TXT

TXT retains the current simple format:

```text
flash = 飞边
EDM electrode = 电火花电极
```

TXT imports do not carry aliases, priority, or `doNotTranslate`.

## Merge and activation rules

Only one meeting configuration is selected at a time.

Imported terms form a custom overlay:

1. Normalize whitespace and compare English keys case-insensitively.
2. A custom term with the same English key replaces the built-in pair.
3. Merge unique aliases from both records.
4. Order custom terms first, then built-in terms by descending priority and
   original configuration order.
5. Activate the first 40 terms.
6. Preserve additional imported terms in the portable configuration, but show
   `40 active / N stored` and explain that lower-priority terms are inactive.

This ordering makes an imported correction effective immediately while keeping
API input bounded and predictable.

## Application data model

Settings add:

```ts
interface GlossaryTerm {
  en: string;
  zh: string;
  aliases: string[];
  doNotTranslate: boolean;
  priority: number;
}

interface GlossaryConfiguration {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  regions: string[];
  domains: string[];
  terms: GlossaryTerm[];
}

interface CaptionSettings {
  glossaryConfigurationId: string;
  customGlossaryConfiguration: GlossaryConfiguration | null;
  glossary: GlossaryTerm[];
}
```

`glossary` remains the compiled runtime list for compatibility with the current
transcription and normalization pipeline. Existing user-entered glossary rows
migrate into a custom configuration so no saved terminology is lost.

Built-in configurations are version-controlled application assets. Custom
configuration data stays in the existing per-user settings file.

## Privacy and security

- Import parsing occurs in the sandboxed renderer from a user-selected local
  file.
- File contents are not transmitted merely because they were imported.
- Only the compiled active terms are later included in OpenAI transcription
  context and normalization requests during a live session.
- The UI states this distinction next to the import control.
- Export uses a native save dialog through a narrow, validated IPC handler.

## Error handling

- Unsupported file: identify the supported extensions.
- Invalid JSON/schema: identify the first actionable validation error.
- Partially invalid CSV/TSV: import valid rows and report rejected row numbers.
- Duplicate entries: merge silently and report the number consolidated.
- More than 40 effective terms: save all, activate 40, and show a non-blocking
  relevance/cost explanation.
- Export cancellation: no notice is necessary.

## Testing

- Unit tests for JSON, CSV, TSV, and TXT parsing.
- Unit tests for validation, sanitization, duplicate merging, priority ordering,
  and the 40-term activation boundary.
- Migration test proving the existing flat glossary becomes a custom
  configuration.
- UI tests for template selection, import feedback, active/stored counts,
  advanced editing, and export invocation.
- Security test proving unsupported IPC senders cannot export files.
- Pack integrity tests for unique IDs, valid bilingual terms, maximum active
  size, and regional alias metadata.

## Acceptance criteria

- A user can configure a typical meeting without typing terminology.
- Four built-in configurations are immediately available offline.
- South China terminology uses canonical output pairs with labelled regional
  aliases.
- A valid glossary file imports without network access.
- A configuration exports as schema-versioned JSON and re-imports without data
  loss.
- No more than 40 terms are sent to normalization for one session.
- Existing manually entered terminology survives migration.
- The same exported file is usable by the future Windows build.
