# Phase 1 provider contract verification

Verified against the official OpenAI documentation on 2026-07-29.

## Production transcription contract

The implementation uses `gpt-live-transcribe` through the Realtime
transcription WebSocket. Its session update matches the documented contract:

- transcription session with 24 kHz PCM audio;
- `gpt-live-transcribe`;
- English and Simplified Chinese language hints;
- prompt, engineering keyword hints, and a tunable delay profile;
- server VAD;
- transcript delta and completed events reconciled by provider item ID.

The provider does not guarantee completion order across turns. The app
therefore releases finals through its source-time reorder coordinator instead
of trusting WebSocket arrival order.

The documented model output does not include detected-language predictions,
confidence, word timestamps, or speaker labels. The application does not
invent these fields. It classifies the assembled text by script and treats
mixed/unknown lines conservatively by normalizing both audience targets.

References:

- [GPT Live Transcribe model](https://developers.openai.com/api/docs/models/gpt-live-transcribe)
- [Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription)

## Translation benchmark contract

`gpt-realtime-translate` uses a dedicated translation WebSocket. One session
has one target language, emits translated transcript deltas while also
generating translated audio, and should receive a separated source track.
Covering two source channels and two audience languages therefore requires
four translation sessions.

The public guide documents continuous input/output transcript deltas but does
not define an utterance-final event that can be truthfully aligned with the
primary `gpt-live-transcribe` item IDs. Phase 1 does not guess at a hidden event
shape or report a false per-utterance comparison.

References:

- [GPT Realtime Translate model](https://developers.openai.com/api/docs/models/gpt-realtime-translate)
- [Realtime translation guide](https://developers.openai.com/api/docs/guides/realtime-translation)

## Contract change triggers

Re-run this verification before changing models or when OpenAI documents any
of the following:

- a transcript-only mode for `gpt-realtime-translate`;
- an utterance-final translation event with stable correlation IDs;
- provider language-identification or confidence fields for
  `gpt-live-transcribe`;
- changed event names, audio formats, prices, or session limits.
