# Overlay focus, synchronized sizing, and caption themes

Date: 2026-07-30  
Status: approved interaction design, awaiting written-spec review

## Purpose

Fix three operator-visible overlay defects and add curated caption themes:

1. captions lose emphasis or move into history while the paired translation is
   still processing;
2. content measurement overrides manual window resizing, and the English and
   Chinese panels can end up at different heights;
3. a new session retains overlay rows from the previous session and interleaves
   captions whose sequence numbers restarted; and
4. operators cannot choose a calm, high-clarity color configuration.

The design preserves W2's immediate 3–10-entry history model, transcript
retention, work-area clamping, and trusted IPC boundary.

## Accepted decisions

- Use semantic caption completion shared by both audience projections.
- Keep every in-flight caption plus the two newest settled captions fully
  focused.
- Keep both overlay windows at one shared height.
- Persist a user-selected height across sessions and app restarts.
- Changing Visible history leaves manual sizing and recalculates automatic
  height.
- Cap the stacked pair at 45% of the work area and side-by-side height at 33%
  of the work area.
- Start every new session with empty overlays. Previous records remain saved.
- Ship four curated, cool Color Hunt themes and use Blueprint by default.

## Approaches considered

### Semantic state and shared window controller — selected

Project aggregate completion with each audience caption and make the main
process authoritative for shared overlay height. This is the only approach
that reliably knows when both translations are settled and whether a resize
was initiated by the user or by the application.

### Renderer-only heuristics

Each panel could infer focus and size locally. This was rejected because one
language may finish before the other, independent renderers can diverge, and a
renderer cannot reliably distinguish user window resizing from `setBounds`.

### Fixed-height presets

Compact, medium, and large presets would avoid the resize feedback loop but
would not satisfy direct manual resizing or automatic sizing from Visible
history.

## Caption completion and focus

### Shared semantic state

`CaptionEvent.status` already describes aggregate English/Chinese state.
`projectForAudience` will add a boolean `settled` field:

```text
settled = aggregate status is final or failed
```

The projected target's existing `status` remains available for displaying
`Translating…`, a final translation, or a target-specific failure. Both
audience windows therefore use the same `settled` value even when their target
states differ.

### Visible cohort

The renderer retains:

- the configured 3–10 most recent settled captions; and
- every unsuppressed in-flight caption.

Within that cohort, the focus group is:

- every in-flight caption; plus
- the two most recent settled captions.

All focused rows use the same prominent type size, weight, and full opacity.
The active provisional row uses the same focus styling; its existing
`Translating…` text communicates pending state. It does not become larger than
the other focused rows. This prevents the reader's focal target from jumping
every time a provisional revision arrives.

Older settled rows use the compact history type size and gradually reduced
opacity, retaining the existing readable opacity floor. A row does not
de-emphasize when its translation completes; it remains one of the two focused
settled rows until two newer captions settle.

Caption revisions continue to replace the row with the same ID. Suppressed
captions are removed.

### New-session boundary

`CaptionSurface` tracks the active `sessionId` from status events. When it
receives `starting` with a different nonempty session ID, it clears all local
caption rows before rendering captions from the new session.

Audience-caption events whose `sessionId` does not match the active session
are ignored once a new session boundary is established. This prevents late
events from the prior session repopulating the overlay.

Saved transcripts and meeting records are unaffected. Crash-recovered records
continue to block Start until Keep or Discard is resolved; the session started
after that decision is visually fresh.

## Shared overlay sizing

### Root cause

The current renderer observes `.caption-roll`, whose height is defined as the
window viewport height. Reporting that measurement to the main process creates
a feedback loop:

```text
window height → viewport measurement → IPC → setBounds → window height
```

It also stores separate English and Chinese measurements, so the two panels
can diverge.

### Natural-content measurement

The caption rows move into an inner content wrapper. The renderer observes
that wrapper's natural block size, not the scroll viewport. Its report
contains:

- audience;
- natural content height, including header and surface padding; and
- the current auto-size generation.

The IPC handler continues to accept reports only from the matching caption
window. It validates audience, finite bounded height, and integer generation.

### Main-process authority

`CaptionWindowManager` owns:

- the latest natural height for each audience;
- a shared automatic height;
- an optional requested manual height;
- an auto-size generation; and
- a guard that distinguishes programmatic bounds changes from user resize
  events.

In automatic mode, the shared height is the larger of the two current natural
content heights. Reports for an old generation are ignored. After Visible
history changes, the manager clears old measurements, increments the
generation, and applies the new shared height after both audience windows have
reported for that generation.

If one caption window is destroyed or has not reported within 250 ms, the
manager uses the available current-generation measurement rather than leaving
the remaining window unusable.

### Direct manual resizing

On Windows and macOS, the manager listens for user-initiated resize events.
While either panel is dragged:

- its requested height becomes the shared manual height;
- the peer panel tracks the same height;
- layout remains bottom-anchored; and
- programmatic peer updates do not feed back as new user intent.

The interaction follows the pointer continuously. Persistence is debounced
until resizing settles so settings are not written on every frame.

Incoming captions, translations, and natural-height reports do not replace a
manual height.

### Persistence and Visible history

Settings gain:

```text
captionOverlayHeight: number | null
```

The stored value is the user's requested height, not a display-clamped height.
Moving to a smaller display temporarily clamps it; returning to a larger work
area restores the request.

When `captionHistoryEntries` changes, the main process:

1. clears `captionOverlayHeight`;
2. increments the auto-size generation;
3. clears prior content measurements;
4. broadcasts the settings/generation; and
5. recalculates one shared automatic height from the new content.

This makes Visible history intentionally control panel height while preventing
ordinary caption traffic from undoing a manual resize.

### Work-area caps

`computeOverlayBounds` will accept one shared requested height.

For stacked layout:

```text
maximum combined panel height, including the gap ≈ 45% of work-area height
```

For side-by-side layout:

```text
maximum shared panel height ≈ 33% of work-area height
```

Both panels always receive equal heights. Content beyond the cap scrolls
inside the panel. The pair remains inside the current display work area,
honors taskbar offsets and negative-coordinate monitors, and grows upward from
its shared bottom anchor.

Manual width and position behavior are not changed by this work.

## Caption themes

### Settings model

Settings gain a validated theme ID:

```text
captionTheme:
  | "blue-air"
  | "blueprint"
  | "steel"
  | "telemetry"
```

`blueprint` is the default for new and migrated settings. Unknown IDs are
replaced with the default.

### Theme definitions

Each theme provides semantic tokens for both audiences:

- surface background;
- primary text;
- secondary text;
- accent;
- border; and
- native Electron window background.

The renderer applies tokens through CSS custom properties. The window manager
uses the matching opaque background when creating/updating `BrowserWindow`, so
loading or resize frames do not flash the old color.

The four Color Hunt sets are:

| Theme | Palette | English surface | Chinese surface |
| --- | --- | --- | --- |
| Blue Air | `#293681 #4274D9 #95CCDD #D0E7E6` | `#293681`, white text | `#D0E7E6`, dark text |
| Blueprint | `#0D47A1 #2196F3 #90CAF9 #E3F2FD` | `#0D47A1`, white text | `#E3F2FD`, dark text |
| Steel | `#112E81 #4647AE #4382DF #AACCD6` | `#112E81`, white text | `#AACCD6`, dark text |
| Telemetry | `#093C5D #3B7597 #6FD1D7 #5DF8D8` | `#093C5D`, white text | `#6FD1D7`, dark text |

Measured primary-text contrast ranges from 8.63:1 to 13.44:1. ENGLISH and 中文
labels remain visible; language identity never depends on color alone.

Sources:

- [Color Hunt: Blue Air](https://colorhunt.co/palette/2936814274d995ccddd0e7e6)
- [Color Hunt: Blueprint](https://colorhunt.co/palette/e3f2fd90caf92196f30d47a1)
- [Color Hunt: Steel](https://colorhunt.co/palette/112e814647ae4382dfaaccd6)
- [Color Hunt: Telemetry](https://colorhunt.co/palette/093c5d3b75976fd1d75df8d8)
- [Apple Human Interface Guidelines: Color](https://developer.apple.com/design/human-interface-guidelines/color)

### Settings UI

The Overlay settings card gains a Caption theme section with four paired
English/Chinese preview swatches. Selecting a theme:

- updates settings immediately;
- broadcasts the validated theme to both overlays;
- updates both visible panels without restart; and
- persists for future launches.

The existing layout, history, and font-scale controls remain in the same card.

## Motion and accessibility

- Focus-state changes use opacity, weight, and type-size transitions only.
- Rows do not translate vertically merely to announce focus state.
- Reduced-motion mode applies focus and height state without animated movement
  or scaling.
- Primary and secondary text colors are semantic per theme.
- Explicit audience and speaker labels remain available to assistive
  technologies and users who cannot distinguish the colors.
- Scroll remains available when content reaches the balanced height cap.

## Error handling

- Invalid theme IDs migrate to Blueprint.
- Invalid, nonfinite, or out-of-range height reports are rejected at IPC.
- Reports from the wrong sender or audience window are rejected.
- Old auto-size generations are ignored.
- Destroyed/missing peer windows do not block the surviving overlay.
- A display too small for the stored manual request clamps temporarily without
  overwriting the preference.
- Late audience events from an old session are ignored after a new session
  begins.

## Test strategy

### Pure/domain tests

- Projected audience captions share aggregate `settled` state.
- In-flight rows remain focused even when one target is final.
- All in-flight rows plus the two newest settled rows form the focus group.
- The configured settled history count remains 3–10.
- Theme IDs validate and migrate to Blueprint.
- Theme text/background pairs retain the approved contrast floor.
- Shared overlay geometry gives equal heights and honors stacked/side-by-side
  caps, work areas, taskbars, negative coordinates, and short displays.

### Renderer tests

- A pending paired translation never receives compact history styling.
- Two settled rows remain focused; the third-oldest becomes history.
- Multiple in-flight rows remain focused simultaneously.
- Revisions replace rows in place.
- A different `starting.sessionId` clears the overlay.
- Late prior-session captions are ignored.
- Theme selection renders four previews and broadcasts/persists the chosen ID.
- Each surface applies the correct semantic theme tokens.
- Natural measurement observes the content wrapper rather than the viewport.
- History changes request a new auto-size generation.

### Main-process tests

- User-resizing either window synchronizes the peer height.
- Programmatic `setBounds` does not masquerade as user intent.
- Manual height survives captions, sessions, and restart.
- Visible history clears manual height and waits for current-generation
  measurements.
- Both panels use the larger natural height and remain equal.
- Sender, audience, height, and generation validation remain enforced.
- Native window backgrounds update with the selected theme.

### Manual validation

- Speak while one audience translation lags and confirm all affected rows stay
  prominent in both panels.
- Resize each panel and verify the peer follows without snap-back.
- Restart the application and confirm the manual height persists.
- Change Visible history from 3 to 10 and back; confirm equal automatic sizing.
- Test stacked and side-by-side modes at 100%, 125%, and 150% scaling and on a
  secondary monitor.
- Stop and start a new session; confirm overlays start empty while the prior
  meeting record remains available.
- Switch through all four themes on both bright and dark underlying
  applications.

## Out of scope

- Arbitrary color pickers or user-authored theme values.
- Changing overlay width or position persistence.
- Resuming the same OpenAI realtime transport after a stopped/crashed session.
- Changing transcript retention or meeting-record decisions.
- Redesigning the control application outside the Overlay settings card.
