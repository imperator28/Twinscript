# Phase 1 quality report

Status: **awaiting live evidence**

Use the in-app 256-prompt screening runner and exported JSON. Report automated
signals separately from blinded bilingual judgment.

Record:

- prompts attempted, completed, skipped, and missing;
- results by English, Chinese, between-sentence code-switch, and inline
  code-switch;
- wrong-language, omission, hallucination, number/unit/ID, terminology, late,
  flutter, and duplicate flags;
- 1–5 semantic score by candidate;
- blinded A/B preferences and ties;
- scripted versus spontaneous provenance.

Do not declare the PRD rate gates passed from 256 samples. Report zero observed
failures with a confidence interval, then use the 1,000+ gate corpus for formal
launch rates.
