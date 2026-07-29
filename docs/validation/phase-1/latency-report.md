# Phase 1 latency report

Status: **awaiting live evidence**

The JSON export records transcription, reorder, normalization, first English,
first Chinese, and end-to-end timing with monotonic stage boundaries.

For each surviving candidate, report p50 and p95 for:

- first source partial;
- same-language readable caption;
- cross-language readable caption;
- final stable caption after speech end;
- reorder delay;
- final normalization.

Separate microphone/system, source language class, provisional/final, and
scripted/spontaneous cohorts. Averages alone are not an exit result.
