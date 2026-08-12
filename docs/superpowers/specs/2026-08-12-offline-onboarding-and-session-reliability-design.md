# Offline onboarding and session reliability

## Goal

Let a user start a fully local session without an OpenAI key, make the viable
model choices clear when no key is present, and prevent a failed audio start or
shutdown task from leaving the operator in an unusable session state.

## Observed failures

- The camera-health renderer request can run before its main-process IPC handler
  exists. The rejected request is not retried, leaving the UI at “Checking the
  virtual camera…” indefinitely even when the camera is installed.
- Session startup creates the transcription pipeline before renderer audio
  capture is attempted. A microphone failure can leave the main session running
  without any audio input, so the camera stage correctly shows its neutral slate
  forever.
- Session shutdown bounds transcription and translation drains, but evaluation
  and meeting-record finalization remain unbounded awaits. A stalled task can
  leave the control button at “Stopping…” indefinitely.
- The default cloud pipeline can be selected even when no API key is stored;
  the setup UI needs to make both the cloud and fully local paths explicit.

## Design

### Model and key guidance

The setup checklist remains the single authority for whether Start is enabled.
When no usable OpenAI key is available, it explains that the user may either add
a key for a cloud stage or select Whisper local and HY-MT2 local for a fully
offline meeting. A fully local configuration does not read, validate, or require
an OpenAI key. The Settings connection card states the same fact and links the
user to the model controls and installation status.

### Startup and output

Renderer startup remains ordered as it is today: main-process pipeline first,
then audio capture. If microphone capture fails, the renderer immediately asks
the main process to stop the just-created session, but that cleanup is bounded.
It then restores the idle UI and shows the capture error. A session never presents
as live when both channels are unavailable.

The output choice is named in setup copy: **On-screen captions** displays native
desktop overlays; **Virtual camera** sends the same captions to a meeting app,
with Camera Stage only as an operator preview. The camera stage's neutral slate
is expected until transcription produces the first caption.

### Camera health

The renderer keeps the subscription but retries the initial health request after
an IPC-not-ready failure, with a short bounded retry policy. A later successful
health snapshot replaces “Checking…”; it cannot remain indefinitely due solely
to application boot order.

### Shutdown

Evaluation recording and meeting-record finalization are wrapped in bounded
drains. A timeout reports a degraded shutdown status, releases the session
admission lock, and returns the control UI to idle. Finalization continues only
when its task is responsive; it must never block the Stop action forever.

## Verification

- Unit test the camera-health retry after an initial IPC failure.
- Unit test that a microphone-start failure returns the UI to idle and calls
  stop cleanup without leaving a session active.
- Unit test bounded evaluation and meeting-record shutdown with deliberately
  unresolved promises.
- Unit test keyless fully local readiness and the no-key setup guidance.
- Run the caption suite, renderer suite, production build, and a manual session
  smoke test that uses local Whisper and HY-MT2 with a microphone.
