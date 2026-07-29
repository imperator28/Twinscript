# Phase 1 screening corpus manifest

The application includes a deterministic **256-prompt scripted screening
corpus** in `src/captions/screeningCorpus.ts`.

| Coverage | Count |
| --- | ---: |
| Total prompts | 256 |
| Code-switch prompts | 128 (50%) |
| Prompts with critical numbers, units, dates, IDs, materials, or finishes | 240 |
| Expected microphone prompts | 128 |
| Expected system-audio prompts | 128 |

Every language class appears on both source channels. Conditions rotate through
quiet speech, headset speech, meeting-compressed audio, fast speech, a pause
before the critical value, light noise, accent variation, and limited overlap.

Each prompt has:

- stable corpus ID;
- expected source channel and language class;
- authoritative scripted source text;
- English and Simplified Chinese reference meaning;
- protected tokens;
- critical-entity flag;
- scripted/spontaneous provenance.

## Operator workflow

1. Enable **Session → Phase 1 screening → Use corpus**.
2. Enable encrypted evaluation recording only after participant consent.
3. For microphone prompts, read the line naturally into the selected
   microphone.
4. For system prompts, play/read the line through the meeting application so
   it reaches the system-audio channel.
5. Advance only after the final caption appears.
6. In **Compare**, assign a 1–5 semantic score, mark failure flags, then choose
   A, B, Tie, or Skip while identities remain blinded.
7. Export JSON and the readable report after each session.

The active prompt is snapshotted when a final transcription item is released,
so advancing the UI while normalization finishes does not relabel that result.

## Evidence boundary

The prompt manifest proves coverage and repeatability; it does not prove speech
quality. Only captured audio and resulting captions count as screening
evidence. Scripted speech must remain labeled as scripted because it
understates spontaneous meeting difficulty.

Automated tests enforce the 200-prompt, 25% code-switch, 50-critical-entity,
unique-ID, bilingual-reference, and dual-channel floors.
