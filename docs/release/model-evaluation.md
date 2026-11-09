# Model evaluation — 2026-11-09

Production defaults remain unchanged. No configured API secrets or consented
bilingual acoustic fixtures were present in the managed cloud environment.
No live quality, latency, failure-rate, soak, or total-cost win is established.
The screening corpus mock validates tooling only; it is not ASR evidence.

## Primary sources checked

Standard short-context USD rates per million text tokens, checked 2026-11-09:

| Model | Input | Cached input | Output | Use |
| --- | ---: | ---: | ---: | --- |
| gpt-5.4-nano | 0.20 | 0.02 | 1.25 | Current economy/preview |
| gpt-5.6-luna | 0.20 | 0.02 | 1.20 | Current quality/final |
| gpt-6-luna | 0.10 | 0.01 | 0.50 | Evaluation candidate only |

Sources: [nano model](https://developers.openai.com/api/docs/models/gpt-5.4-nano),
[Luna model](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[GPT-6 Luna model](https://developers.openai.com/api/docs/models/gpt-6-luna),
[pricing](https://developers.openai.com/api/docs/pricing).
The model pages distinguish cache reads, writes, regional processing and long
contexts. These estimates cover the app's short requests, not every billing tier.
The production meter's prior Luna rates (1 / 0.1 / 6) were incorrect.

[GPT-Live-Transcribe](https://developers.openai.com/api/docs/models/gpt-live-transcribe)
remains USD 0.017 per audio minute. Translation adds text usage on top of ASR.
[Deprecations](https://developers.openai.com/api/docs/deprecations) lists nano's
shutdown as April 1, 2027; evaluating a successor is required before that date.

Google's [live transcription guide](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe)
identifies `gemini-3.5-transcribe-live` as the dedicated WebSocket ASR model.
Its [pricing page](https://ai.google.dev/gemini-api/docs/pricing) advertises an
estimated blended rate near USD 0.009/audio minute, based on assumed audio/text
token counts. This is not a measured Twinscript cost. Full Google pages redirected
to AI Studio and could not be retrieved by the documentation reader in this run;
indexed official excerpts confirm the model, but the live wire contract and
exact applicable paid rates need a fresh check before paid execution. Do not
substitute a conversational voice model or add speech generation.

## Acceptance evidence still required

Use identical consented Mandarin, English and within-utterance mixed speech,
including numbers, units, EVT/DVT/PVT/T1/T2 and manufacturing terms. Retain separate
microphone/system provenance, PCM sample ranges and original capture timestamps.
Report ASR CER/WER and numeric/token errors independently from text translation.
For translation report both complete audience outputs and human-reviewed language,
meaning and terminology accuracy. Report p50/p95 first/final latency, revisions
after final, failures, dropped audio and 30–60 minute behavior. Count every billed
attempt, including malformed or incomplete responses, and both audience targets.

Current live transport timestamps are explicitly `local-send` (or `receipt` when
uncorrelated), not acoustic onset. Do not describe derived latency as acoustic
end-to-end latency. Production default migration requires actual paired evidence;
synthetic text references and cheaper advertised rates alone are insufficient.

Local Whisper remains experimental. Source inspection confirms a 64-token decode
cap and reuse of the previous supported language when detection falls outside
en/zh. Neither truncation frequency nor code-switch quality has been measured;
do not promote or retune it based on source inspection alone.
