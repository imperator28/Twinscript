# Local Whisper Language-Switch Quality Recovery

## Problem

The September language-reacquisition changes reduced the native Whisper phrase boundary from 500 ms of quiet to 250 ms and reduced the continuous-audio cap from 20 seconds to 3 seconds. Whisper Small now receives fragments that are often too short for reliable automatic language identification. In English speech this has produced Swedish fragments such as `Tjena` and `Det är`, after which HY-MT2 correctly translates the incorrect transcript.

The repetition bound added later is a separate safeguard. Its 64-token ceiling does not explain short, wrong-language transcripts and remains in scope.

## Decision

Recover transcription quality before optimizing language-switch latency.

1. Restore a 500 ms quiet phrase boundary.
2. Use a 12-second maximum utterance window. This is shorter than the original 20-second cap but four times the regressed 3-second cap, providing substantially more acoustic and linguistic context while still forcing periodic language reconsideration.
3. Preserve the existing two-second provisional decode interval, pre-roll, automatic language detection, and 64-token repetition bound.
4. Do not discard or reset audio merely because a potential language switch is detected. Natural phrase boundaries and the maximum window remain the only finalization triggers.

The 12-second compromise is preferred over an immediate return to 20 seconds because the measured NPU run decoded 9.7 seconds of audio in about 0.83 seconds, leaving comfortable real-time headroom while limiting worst-case switch delay. If user validation still shows poor language identification, the cap can be raised to 20 seconds without changing the interface.

## Alternatives Considered

- **Exact rollback to 500 ms / 20 seconds:** Highest confidence for quality, but a speaker who code-switches continuously without pausing may wait up to 20 seconds for a final-language reset.
- **Keep 250 ms / 3 seconds:** Fastest theoretical reacquisition, but the observed production behavior shows unacceptable fragmenting and language hallucination.
- **Confidence-confirmed rolling language detector:** Best eventual behavior, but the current OpenVINO GenAI Whisper result does not expose a stable per-language confidence contract. Adding a second detector would broaden this recovery into a new subsystem.

## Data Flow

Audio continues through the existing JavaScript VAD and native Whisper host. The native utterance gate accumulates speech, emits provisional transcriptions at the existing interval, and finalizes after 500 ms of quiet or 12 seconds of accumulated speech. Finalization resets Whisper's automatic language decision for the next utterance without dropping queued samples.

## Failure Handling

The existing queue-overflow warning remains active. The 12-second cap does not increase queued audio indefinitely, and the measured NPU throughput provides margin. The repetition filter and token limit remain unchanged to prevent pathological decoding from monopolizing the NPU.

## Validation

- A native unit test must fail under the 250 ms / 3-second behavior and pass only when the gate requires 500 ms of quiet and permits speech until 12 seconds.
- Existing native segmentation, generation-policy, protocol, Electron caption, and packaging tests must remain green.
- Rebuild the native sidecar and packaged beta.
- Run the real NPU Whisper smoke test against the installed Whisper Small model.
- Manually validate an English-to-Chinese switch and a Chinese-to-English switch using complete phrases. Success means no foreign-language hallucinated fragments, no missing first words after the switch, and no queue-overflow warning under normal speech.

## Scope

This recovery changes only native Whisper segmentation. It does not change HY-MT2, pipeline selection, caption presentation, model installation, or cloud transcription.
