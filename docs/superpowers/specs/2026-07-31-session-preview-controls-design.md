# Session and Audience Preview Controls Design

**Date:** 2026-07-31  
**Scope:** Session action hierarchy, output routing, and native audience-preview visibility

## Problem

Three related behaviors make the Session view misleading:

1. Starting a session always shows both lower-third windows, even when Virtual
   camera is the selected output.
2. Audience View exposes only a one-way Show action. The frameless 16:9 camera
   stage also has no direct way to hide it.
3. Start/Stop Session is presented as a separate card below configuration,
   while session status and elapsed time occupy the more prominent top-right
   pill.

The root cause of the first issue is the session-start IPC handler calling
`showAll()` unconditionally instead of applying the selected output mode. The
other two issues are missing interaction and hierarchy contracts rather than
rendering failures.

## Approved interaction model

### Integrated session action

The top-right status pill becomes the only Start/Stop control:

- Idle: **Start session**.
- Starting: **Starting…**, disabled.
- Live: **Stop session | elapsed time**.
- Stopping: **Stopping… | elapsed time**, disabled.
- A completed session returns to **Start session**.

The existing separate launch/status card is removed. Credential and recovered
record constraints continue to disable Start session. The reason remains
available in the existing notice/recovery UI and Settings connection card.

The pill remains keyboard accessible, uses a real `button`, retains the live
status dot, and has an accessible name that includes the current action and
elapsed time when live.

### Selected-output routing

Starting a session displays exactly one output family:

- **On-screen captions:** show both lower-third windows and hide the camera
  stage.
- **Virtual camera:** hide both lower-third windows and show the camera stage.

This routing does not restart transcription and does not change the persisted
output-mode preference. Switching output mode during a session immediately
applies the same mutually exclusive routing.

### Stateful audience preview

Audience View replaces the one-way Show action with one stateful button:

- **Preview** when the selected output family is hidden.
- **Hide preview** when the selected output family is visible.

Preview visibility is transient and is not added to persisted settings. The
main process owns the authoritative visibility state because native windows can
also be hidden outside React.

The window manager publishes a serializable visibility snapshot shaped as
`{ overlaysVisible: boolean, cameraStageVisible: boolean }`. Overlay preview is
considered visible only when both audience windows are visible; if either was
closed, **Preview** restores the pair. The control renderer updates from that event after mode
changes, preview actions, session startup, and native window close/hide events.
Optimistic renderer-only state is intentionally avoided because it would drift
after Esc or a native close event.

### Frameless camera-stage dismissal

The 16:9 camera stage remains frameless so OBS receives only the designed
surface. Pressing Esc requests `hideCameraStage()` through the existing secure
preload bridge. Hiding the stage does not stop the caption session, change the
output mode, or destroy the reusable camera-stage window.

When Esc hides the stage, the control window receives the updated visibility
snapshot and changes **Hide preview** back to **Preview**.

## Component boundaries and data flow

1. `CaptionWindowManager` owns native-window visibility and adds one operation
   that applies the currently selected output family.
2. Session-start IPC starts transcription, then calls that output-aware
   operation instead of `showAll()`.
3. Show/hide methods and native hide/close events publish a visibility
   snapshot to the control renderer.
4. `ControlApp` renders the stateful Preview button and the integrated session
   action pill from session state, elapsed metrics, constraints, and the native
   visibility snapshot.
5. `CameraStage` listens for Esc and invokes the existing hide-stage bridge.

No new persistent setting is introduced, and camera-stage caption projection
remains unchanged.

## Error handling

- A failed preview IPC request leaves the last confirmed visibility state in
  place and surfaces the returned error through the existing notice area.
- Start failures retain the existing session-start recovery behavior; no
  audience windows are shown until the start request succeeds.
- Visibility events contain booleans only and are accepted only from the
  trusted main-process bridge.

## Test strategy

Test-first coverage will prove:

1. Session startup in overlay mode shows overlays and hides the stage.
2. Session startup in virtual-camera mode hides overlays and shows the stage.
3. Window show, hide, close, and Esc update the authoritative visibility
   snapshot without changing session state or output mode.
4. Audience View renders exactly one stateful **Preview / Hide preview** button
   for the selected output family and invokes the correct secure bridge action.
5. The app header renders **Start session** when idle and **Stop session |
   timer** when live, with correct disabled transitional and constraint states.
6. The previous standalone launch card is absent, while recovery and
   credential constraints still protect session startup.
7. Existing camera-stage privacy, output-mode switching, overlay lifecycle,
   and recording tests remain green.

## Out of scope

- Persisting preview visibility across restarts.
- Adding visible controls inside the OBS-captured camera-stage surface.
- Changing OBS scene configuration or virtual-camera registration.
- Changing transcript, recording, glossary, or caption-history behavior.
