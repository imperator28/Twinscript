# Phase 1 architecture decision

Status: **implementation selected; live product evidence pending**
Date: 2026-07-29

## Selected foundation

- Two independent `gpt-live-transcribe` sessions: microphone and system audio.
- One canonical caption event projected to separate English and Simplified
  Chinese always-on-top windows.
- Script-aware same-language fast path plus structured text normalization for
  the opposite audience.
- Economy primary versus Tiered shadow as the first blinded A/B.
- Low transcription delay, local VAD, 400 ms final reorder window, duplicate
  suppression, bounded queues, and a $5 default hard session cap.

This is the lowest-cost architecture that directly serves a subtitle-only
product while preserving an isolated quality ceiling.

## Realtime Translate disposition

`gpt-realtime-translate` is **not a Phase 1 production dependency** and is not
run by default.

At published list prices:

| Candidate | Continuous audio streams | Audio cost / 60 min |
| --- | ---: | ---: |
| Selected transcription foundation | 2 × $0.017/min | $2.04 |
| Realtime Translate dual-channel/dual-audience fan-out | 4 × $0.034/min | $8.16 |

The translation fan-out would add $8.16 per hour before the selected
transcription and any text normalization, generate audio that this product
discards, and lacks a documented per-utterance final event that can be aligned
to the primary A/B record. Building against an inferred event is rejected.

Trigger a bounded Realtime Translate probe only if all of these become true:

1. Economy versus Tiered remains inconclusive on a representative subset.
2. A dedicated evaluation budget is approved in the app and provider project.
3. The current API contract is reverified.
4. The live probe first captures and documents a stable final/correlation
   event, or the evaluation is explicitly reported as session-level rather
   than utterance-level.

This is a gated elimination, not a claim that translation quality is inferior.

## Cost expectation

For one weekly 30–60 minute session, the two continuously submitted
transcription channels cost approximately $1.02–$2.04 per session, or
$4.42–$8.83 in an average 4.33-session month, before text normalization.
Local VAD may lower submitted audio, but only live provider usage can establish
the real amount.

The PRD launch cost gate remains unapproved until the live report separates
transcription and normalization costs and compares the app estimate with the
provider dashboard.

## Open evidence gates

- representative bilingual screening judgments;
- remote participant confirmation of both overlays during full-screen share;
- device switch, sleep/wake, display/Space checks;
- 60-minute macOS soak;
- measured cost and final Economy/Tiered selection.

No Phase 2 approval is recorded yet.
