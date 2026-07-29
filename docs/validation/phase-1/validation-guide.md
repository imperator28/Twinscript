# macOS Phase 1 validation guide

This build is ready for the developer's live judgement. The offline demo,
secure desktop boundary, two caption surfaces, live primary/shadow pipeline,
cost meter, and encrypted replay path are implemented. The measurements and
product decision must come from real bilingual sessions.

## Before the first live session

1. Put the key in `.env.local` for development, or use **Settings → OpenAI →
   Validate & save** in the packaged app. Follow
   [API key setup](../../security/api-key-setup.md).
2. Use a dedicated OpenAI project with a dashboard spend limit.
3. Grant Microphone and Screen Recording permission when macOS asks.
4. Use headphones. This keeps meeting playback out of the microphone channel.
5. Open **Demo Session** once and confirm the English and Chinese lower thirds
   are visible in the shared desktop.
6. Test both **Stacked** and **Side by side** while sharing the entire screen.

## Recommended first A/B

- Primary: **Economy** (`gpt-5.4-nano` provisional and final)
- Shadow: **Tiered** (`gpt-5.4-nano` provisional,
  `gpt-5.6-luna` final)
- Delay: **Low**
- Fast path: on
- Provisional translation: on
- VAD: on
- Session cap: **$5**

The primary result is the only one shown to the meeting. The shadow result is
isolated in **Compare** and cannot delay the audience caption. Candidate A and
Candidate B alternate positions and remain blinded until a judgment is saved.
Use **Settings → Stop shadow comparison** if cost or provider health makes the
extra candidate undesirable during a live session.

## Ten-minute shakedown

Speak or play examples from all of these groups:

- natural Mandarin;
- natural English;
- Chinese containing a short acronym such as DVT;
- code-switching such as “这个 boss 的 wall thickness 太薄”;
- dimensions and tolerances;
- part numbers and dates;
- interruptions and short acknowledgements;
- one intentionally noisy segment.

For each failure, note the line number and classify it:

- wrong audience language;
- meaning changed;
- engineering term changed;
- number, unit, date, or part number changed;
- caption too late;
- distracting provisional reversal;
- duplicate microphone/system line;
- reconnect or missing line.

Expand **Diagnostic evidence** under a compared line to inspect transcript,
ordering, normalization, and end-to-end timing plus automated script and
protected-token warnings. These warnings screen for likely failures; bilingual
judgment remains authoritative.

Export both JSON and the readable log at the end.

## Scripted screening corpus

After the shakedown, enable **Session → Phase 1 screening → Use corpus**. The
runner contains 256 prompts and shows the expected source channel:

- read microphone prompts into the selected microphone;
- play system prompts through the meeting application;
- wait for the final caption, then choose **Mark spoken · Next**;
- use **Compare → Quality score and failure flags** before choosing A/B.

The app snapshots the active prompt when the final provider item arrives and
stores its ID with the evaluation. Do not advance before the final appears.
The reference disclosure is for adjudication; keep it closed during the first
read if you want to minimize reviewer bias.

It is fine to split the corpus across several sessions. Export each session,
and keep encrypted fixtures local. The scripted corpus is a Phase 1 screening
tool, not sufficient evidence for the formal launch-rate gates.

## Thirty-to-sixty-minute meeting validation

Use the actual meeting application and share the full desktop. Confirm from a
remote participant's view that both solid overlays remain visible in:

- a normal meeting window;
- fullscreen meeting mode;
- fullscreen presentation mode.

Judge Economy versus Tiered in **Compare** without changing the live meeting.
Record a preference only when the meaning or terminology differs materially;
small stylistic differences do not justify a higher-cost profile.

Expected transcription baseline at the published `$0.017/audio minute` price:

| Wall-clock session | Two continuously submitted channels |
| --- | ---: |
| 30 minutes | about $1.02 |
| 60 minutes | about $2.04 |

VAD may reduce submitted audio, but the savings must be verified from
provider-reported usage. Text normalization adds a smaller variable amount.
The in-app meter is an estimate; the OpenAI dashboard is authoritative.

## Encrypted evaluation recording

Normal sessions do not store raw audio. To create a replay fixture:

1. obtain participant consent;
2. enable **Settings → Validation log → Record an encrypted evaluation
   fixture** before starting;
3. run the session;
4. end the session cleanly;
5. use **Replay Last** to test rendering without another model call.

Fixtures are stored in the app user-data directory, encrypted with
AES-256-GCM, and pruned after seven days. Never commit recordings.

## Decision rule

Keep Economy if it preserves meaning, engineering terminology, numbers, units,
dates, and language direction as reliably as Tiered. Select Tiered only when
the blinded comparison shows repeatable, material quality improvements worth
the premium. Disable the fast path if mixed-language revisions feel unstable;
the final dual-target normalization remains authoritative either way.

Do not call Phase 1 validated until the remote overlay check and a real
30–60-minute bilingual session have passed. Those are user-observation gates,
not automated build gates.

See [readiness matrix](readiness-matrix.md) for the implementation-to-evidence
mapping and the exact remaining gates.
