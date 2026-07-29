# Phase 1 validation readiness matrix

Status: **implementation-ready for macOS live validation; product gate remains
open**.

This matrix separates code readiness from evidence that can only be produced
in a real bilingual meeting. Phase 1 is not declared complete until the user
finishes the remote-overlay check, representative A/B review, and soak.

| Workstream | Implementation evidence | Status before user validation |
| --- | --- | --- |
| P1-1 contracts and deterministic fixtures | Caption domain, fake demo/replay, 13 focused foundation tests | Ready |
| P1-2 live transcription adapter | Two bounded main-process `gpt-live-transcribe` WebSockets, reconnect and usage events | Ready; live API check required |
| P1-3 VAD experiment | Per-channel VAD with pre/post-roll, continuous submitted-audio and drop metrics | Ready; billing/onset comparison required |
| P1-4 assembly and ordering | Provider item assembly, configurable 400 ms reorder buffer, stable final sequence, cross-channel duplicate suppression | Ready |
| P1-5 routing and passthrough | English/Chinese/mixed classifier, same-language fast path, divergence signals, disable switch | Ready |
| P1-6 normalization candidates | Economy/Tiered/Quality profiles, structured output, stable prompts, bounded priority queue, cancellation, retry and per-utterance provisional cap | Ready; model-quality decision required |
| P1-7 pipeline and caption bus | Main-process orchestrator, identical canonical event projected to two audience windows, isolated/abortable shadow | Ready |
| P1-8 record/replay | Opt-in AES-256-GCM fixtures, protected installation key, authenticated records, atomic manifests, accelerated replay | Ready |
| P1-9 A/B shell | Blinded alternating A/B candidates, saved judgments, latency stages, automated quality signals, cost and transport diagnostics, JSON/Markdown exports | Ready |
| P1-10 comparison adapters | Normalization-profile comparison is built. Official-contract and cost review gates the four-stream realtime-translate probe behind an inconclusive Economy/Tiered result; see architecture decision. | Ready; conditional probe not triggered |
| P1-11 corpus and scoring | 256-prompt in-app runner, stable prompt/result linkage, dual-channel and code-switch coverage tests, blinded preference, 1–5 semantic score, failure flags, encrypted fixture, JSON/Markdown export | Ready; speech capture and judgments are user-run |
| P1-12 observability and budget | Audio/text cost by stage, queue depth, drops, reconnects, duplicates, latency stages, 75% warning, hard stop at cap | Ready |
| P1-13 resilience and soak | Deterministic retry/backpressure/budget/encryption tests are built | Device switch, sleep/wake, display/Space changes, and 60-minute soak are user-run |

## Automated checks

Run from the repository root:

```bash
npm run test:captions
npm run build
npm audit --omit=dev
npm run package
```

The focused suite covers:

- language routing and final-state monotonicity;
- source-time ordering and cross-channel duplicate detection;
- bounded priority/backpressure behavior;
- final retry versus provisional no-retry behavior;
- VAD pre/post-roll;
- protected-token and wrong-script diagnostics;
- authenticated encrypted fixture recovery and tamper rejection;
- hard budget shutdown.

## Remaining judgment gates

1. Verify both lower thirds from a remote participant's view while the entire
   desktop is shared, including fullscreen presentation.
2. Run the 10-minute bilingual shakedown and rate A/B lines before profiles are
   revealed.
3. Run the 256-prompt screening set over one or more consented/scripted sessions.
4. Run one representative 30–60-minute meeting and compare the in-app estimate
   with provider-reported usage.
5. Complete the 60-minute reliability soak with both audience windows open.
6. Record the selected profile, VAD/fast-path decision, measured hourly cost,
   limitations, and rejected candidates in the architecture decision.
