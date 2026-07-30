# Production UI Cleanup

**Status:** Approved  
**Date:** 2026-07-30

## Goal

Make Bilingual Meeting Captions feel like a focused meeting utility instead of
an evaluation harness. A user should understand the app in this order:

1. confirm the microphone and meeting audio;
2. choose how the audience captions appear;
3. start or stop the meeting;
4. watch the live bilingual transcript;
5. adjust infrequent caption and glossary settings when needed.

## Product interface

The primary navigation contains only **Session** and **Settings**.

### Session

- Meeting audio and microphone test
- English/Chinese audience layout preview
- Caption pace
- Start Session / Stop Session
- Latest bilingual captions
- Running cost and audio-retention statement

The Session screen does not expose demo sessions, replay fixtures, screening
corpora, phase labels, evaluation instructions, or model comparison.

### Settings

- OpenAI credential
- Caption quality and budget protection
- Caption timing and text size
- Meeting glossary
- Session transcript export

Model names are implementation details. The visible quality selector uses
plain-language choices: **Economy**, **Recommended**, and **Best quality**.

## Removed from the product UI

- Phase 1 scripted prompt runner
- Compare or Advanced Validation navigation
- Shadow comparison controls and blinded rating interface
- Encrypted evaluation recording controls
- Replay fixture controls
- Gate, corpus, phase, and diagnostic language

The evaluation backend and test corpus remain in the repository for developer
use and regression testing. They are not discoverable from the packaged
product interface.

## Runtime safety

- Shadow comparison defaults to disabled.
- Settings migrate to version 4.
- Migration disables `shadowEnabled` and `recordEvaluation` for existing
  installations so removing their controls cannot leave hidden API spending or
  recording active.
- Normal session starts explicitly omit screening prompts and evaluation
  recording.

## Verification

- UI tests assert that validation-era controls and wording are absent.
- Session start tests assert `mode: live`, no screening prompt, and no hidden
  evaluation settings.
- Existing caption routing, pacing, credential, cost, and audio tests continue
  to pass.
- A production build and packaged macOS app are verified before publication.

## Scope check

This cleanup does not delete diagnostic backend modules, redesign caption
overlays, change OpenAI models, or implement the approved glossary-template
feature. Those remain independent work.
