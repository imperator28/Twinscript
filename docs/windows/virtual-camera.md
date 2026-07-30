# Windows virtual-camera path

The virtual-camera feature has two stages:

1. **OBS validation** proves that the bilingual full-screen transcript is
   useful in real meetings.
2. **Native Windows 11 camera** removes the OBS dependency after the experience
   is proven.

This order avoids making camera-driver work the prerequisite for validating
caption quality, layout, and meeting behavior.

## Camera-stage product behavior

Add a third presentation surface alongside the two desktop overlays:

```text
┌──────────────────────────────────────────────────────────────────┐
│ ENGLISH                                              ● LIVE       │
│                                                                  │
│ YOU      We need the T2 fixture before Friday.                   │
│ MEETING  The supplier can finish the steel insert tomorrow.      │
├──────────────────────────────────────────────────────────────────┤
│ 中文                                                  ● 实时       │
│                                                                  │
│ 你       我们星期五之前需要 T2 治具。                              │
│ 会议     供应商明天可以完成钢制镶件。                               │
└──────────────────────────────────────────────────────────────────┘
```

Requirements:

- fixed 16:9 content area, initially 1920×1080;
- English occupies the upper half and Simplified Chinese the lower half;
- solid, distinct high-contrast backgrounds;
- one shared sequence of complete caption entries;
- source label (`YOU` or `MEETING`) on every entry;
- 3–10 visible-history entries, using the same setting as the overlays;
- text safe area of at least 5% on all edges;
- no control buttons, cursor, API state, cost, or settings in the feed;
- no transparency;
- reflow animation only, with a reduced-motion path;
- a disconnected state that is obvious but does not expose technical details;
  and
- a privacy slate before the first session and after the session stops.

The camera stage consumes audience projections from the main-process state hub.
It must not open another transcription or normalization connection.

## W3: OBS-first validation

OBS Studio exposes its current scene as a webcam through **Start Virtual
Camera**. This path is supported by OBS and is suitable for validating Zoom,
Teams, Google Meet, or another webcam-capable meeting client.

### App implementation

Add an output mode selector:

- **On-screen captions**
- **Virtual camera**

For the OBS implementation, **Virtual camera**:

1. opens a dedicated camera-stage window;
2. keeps the window at an exact 16:9 aspect ratio;
3. explains once that OBS Virtual Camera is the active bridge;
4. offers **Open camera stage** if the window is hidden; and
5. returns to overlays without ending the transcription session.

Keep the stage as a normal capturable window. Do not minimize it while OBS is
capturing it. It may be placed on another display or behind the meeting window
only after the chosen OBS capture method is verified.

### OBS setup on Windows

Install the official OBS build:

```powershell
winget install -e --id OBSProject.OBSStudio
```

Then:

1. Open OBS.
2. Set **Settings → Video → Base (Canvas) Resolution** to `1920x1080`.
3. Set output resolution to `1920x1080`.
4. Use 30 fps initially. If the machine is resource-constrained, 15 fps is
   sufficient for caption motion.
5. Create a scene named `Bilingual Captions`.
6. Add a **Window Capture** source for the app's camera-stage window.
7. Fit the source to the canvas and confirm there is no browser or window
   chrome in the content area.
8. In the OBS Controls dock, select **Start Virtual Camera**.
9. In the meeting app, select **OBS Virtual Camera** as the camera.

If **Start Virtual Camera** is missing, follow the official
[OBS Virtual Camera Troubleshooting](https://obsproject.com/kb/virtual-camera-troubleshooting)
instructions. On a standard Windows installation, OBS includes the component;
repairing it may require running the included installer script as
administrator.

### W3 test scenarios

Validate at minimum:

- Teams desktop;
- Zoom desktop; and
- one Chromium meeting surface, preferably Google Meet in Edge or Chrome.

For each client:

1. join a private test meeting;
2. select OBS Virtual Camera;
3. speak English and Chinese from the microphone;
4. play English and Chinese meeting audio;
5. code-switch inside one utterance;
6. confirm every attendee sees both halves;
7. switch to on-screen captions and back without stopping the session;
8. change visible history from 3 to 10;
9. resize or move the stage and confirm OBS remains correctly framed; and
10. run a 60-minute soak.

Record:

- meeting-client version;
- time to first caption;
- time from finalized source to both audience texts;
- dropped-audio duration by channel;
- camera freezes or black frames;
- CPU, memory, and GPU range;
- whether the stage remained readable in gallery and speaker views; and
- user judgment: **keep OBS**, **proceed to native**, or **revise the stage**.

## W4: native Windows 11 camera

Microsoft's `IMFVirtualCamera` API has a minimum supported client of Windows
Build 22000. Use it for Windows 11 only.

### Selected architecture

Use a signed x64 C++ companion process:

- Media Foundation media source;
- virtual-camera registration and lifecycle;
- one shared-memory frame buffer with a small header;
- one named pipe for control and health messages; and
- a monotonic 15/30 fps frame clock.

Electron owns:

- the caption state;
- rendering the 16:9 camera stage into BGRA frames;
- starting/stopping the companion;
- Windows version and architecture checks;
- user-facing health/recovery state; and
- falling back to OBS.

The companion owns:

- `MFStartup`/`MFShutdown`;
- media-source activation;
- `MFCreateVirtualCamera`;
- `IMFVirtualCamera::Start`, `Stop`, `Remove`, and `Shutdown`;
- requested media-type negotiation;
- repeating the newest valid frame when Electron misses a deadline; and
- native diagnostics that never include transcript text.

### Frame transport contract

Version the shared-memory header from the first prototype:

```text
magic
protocolVersion
width
height
pixelFormat
stride
frameSequence
capturedAtMonotonicNs
payloadBytes
writerState
```

Start with:

- 1920×1080;
- BGRA8;
- 15 fps, configurable to 30 fps;
- double buffering;
- atomic frame-sequence publication; and
- last-frame repeat for up to two seconds before a neutral disconnected slate.

Do not send one frame per JSON/IPC message. Use IPC only for lifecycle and
health.

### Failure behavior

- Companion cannot start: keep the live caption session running and offer OBS.
- Camera registration fails: show the exact Windows error code and cleanup
  state; do not request repeated elevation.
- Meeting app has camera open: stop/restart should explain that the meeting app
  may need to release or reselect the camera.
- Electron renderer stalls: repeat the last frame, then show the neutral slate.
- Companion crashes: restart once automatically; further attempts are manual.
- App exits: stop and shut down the camera cleanly.
- Uninstall: remove the registered camera and companion files.

### Native-camera acceptance

W4 passes only when:

- the camera appears under a stable product name after install;
- Teams, Zoom, and a Chromium meeting surface enumerate and display it;
- install, update, repair, and uninstall leave no orphan registration;
- switching output modes does not interrupt transcription;
- a companion crash does not end the meeting session;
- the feed completes a 60-minute soak without a frozen or black frame;
- the signed production artifact works for a standard non-admin user after
  installation; and
- Windows 10 receives a clear OBS fallback instead of a broken native option.

## Explicit exclusions

The first native version does not include:

- a meeting bot that joins as an attendee;
- camera or screen compositing behind captions;
- translated speech or a virtual microphone;
- DirectShow support for Windows 10;
- Windows on Arm native-camera support;
- 4K output;
- remote control of OBS; or
- automatic installation of third-party camera software.

## Official references

- [OBS Virtual Camera Guide](https://obsproject.com/kb/virtual-camera-guide)
- [OBS Windows Installation](https://obsproject.com/kb/windows-installation)
- [OBS Virtual Camera Troubleshooting](https://obsproject.com/kb/virtual-camera-troubleshooting)
- [Microsoft `IMFVirtualCamera`](https://learn.microsoft.com/en-us/windows/win32/api/mfvirtualcamera/nn-mfvirtualcamera-imfvirtualcamera)
- [Microsoft `IMFVirtualCamera::Start`](https://learn.microsoft.com/en-us/windows/win32/api/mfvirtualcamera/nf-mfvirtualcamera-imfvirtualcamera-start)

