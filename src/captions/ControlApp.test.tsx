import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlApp } from './ControlApp';

const audioMocks = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue({ microphone: true, system: true }),
  stop: vi.fn().mockResolvedValue(undefined),
  // The preview now meters both channels and reports whether loopback started, so
  // the mock has to drive the system callback and return a result.
  previewStart: vi.fn().mockImplementation(
    async (
      _deviceId: string,
      onLevel: (level: number) => void,
      onSystemLevel?: (level: number) => void,
    ) => {
      onLevel(0.04);
      onSystemLevel?.(0.06);
      return { microphone: true, system: true };
    },
  ),
  previewStop: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./audioCapture', () => ({
  AudioCaptureController: class {
    start = audioMocks.start;
    stop = audioMocks.stop;
  },
  MicrophonePreviewController: class {
    start = audioMocks.previewStart;
    stop = audioMocks.previewStop;
  },
  enumerateAudioDevices: vi.fn().mockResolvedValue({
    inputs: [{ deviceId: 'mic-1', label: 'Test microphone' }],
    outputs: [],
  }),
}));

let statusListener: ((status: { state: string; message?: string }) => void) | undefined;
let metricsListener: ((metrics: Record<string, unknown>) => void) | undefined;
let captionListener: ((caption: Record<string, unknown>) => void) | undefined;
let backupStateListener: ((state: Record<string, unknown>) => void) | undefined;
let pendingRecordsListener: ((records: Record<string, unknown>[]) => void) | undefined;
let previewVisibilityListener:
  | ((visibility: {
      overlaysVisible: boolean;
      cameraStageVisible: boolean;
    }) => void)
  | undefined;
let nativeCameraHealthListener:
  | ((health: {
      state: string;
      supported: boolean;
      installed: boolean;
      message?: string | null;
    }) => void)
  | undefined;

const settings = {
  settingsVersion: 10,
  layout: 'stacked',
  outputMode: 'overlays',
  primaryProfile: 'economy',
  shadowProfile: 'tiered',
  shadowEnabled: false,
  fastPath: true,
  provisionalTranslation: true,
  vadEnabled: true,
  vadThreshold: 0.012,
  delayProfile: 'low',
  budgetUsd: 5,
  glossaryConfigurationId: 'universal-engineering',
  customGlossaryConfiguration: null,
  glossary: [
    {
      en: 'flash',
      zh: '飞边',
      aliases: ['批锋'],
      doNotTranslate: false,
      priority: 5,
    },
  ],
  protectedTokens: ['T1', 'T2', 'EVT', 'DVT', 'PVT'],
  glossaryStoredCount: 138,
  captionFontScale: 1,
  autoSaveTranscript: true,
  keepAudioAutomatically: false,
  meetingRecordsDirectory: null,
  captionHistoryEntries: 6,
  captionTheme: 'blueprint',
  captionOverlayHeight: null,
  showSourceInControl: true,
  recordEvaluation: false,
  recordingRetentionDays: 7,
  reorderWindowMs: 400,
  duplicateWindowMs: 1400,
};

/** The channel-health badge text for one capture row. */
function channelBadge(rowLabel: string) {
  const row = screen.getByText(rowLabel).closest('.audio-row');
  return row?.querySelector('.channel-badge')?.textContent ?? null;
}

describe('meeting caption controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    audioMocks.start.mockResolvedValue({ microphone: true, system: true });
    statusListener = undefined;
    metricsListener = undefined;
    captionListener = undefined;
    backupStateListener = undefined;
    pendingRecordsListener = undefined;
    previewVisibilityListener = undefined;
    nativeCameraHealthListener = undefined;
    const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
    window.captions = {
      onStatus: (callback) => {
        statusListener = callback;
        return () => {};
      },
      onMetrics: (callback) => {
        metricsListener = callback;
        return () => {};
      },
      onCaption: (callback) => {
        captionListener = callback as unknown as typeof captionListener;
        return () => {};
      },
      onEvaluation: () => () => {},
      onAudienceCaption: () => () => {},
      onLayout: () => () => {},
      onSettings: () => () => {},
      onBackupState: (callback) => {
        backupStateListener = callback as unknown as typeof backupStateListener;
        return () => {};
      },
      onPendingMeetingRecords: (callback) => {
        pendingRecordsListener = callback as unknown as typeof pendingRecordsListener;
        return () => {};
      },
      onPreviewVisibility: (callback) => {
        previewVisibilityListener = callback;
        return () => {};
      },
      onNativeCameraHealth: (callback) => {
        nativeCameraHealthListener = callback;
        return () => {};
      },
      getSettings: () => ok(settings),
      getGlossaryConfigurations: () =>
        ok([
          {
            id: 'universal-engineering',
            name: 'Universal engineering',
            description:
              'Mechanical design, manufacturing, quality, tooling, and supplier terminology.',
            regions: ['Guangdong', 'Shenzhen', 'Dongguan'],
            domains: ['mechanical design', 'manufacturing', 'quality', 'tooling'],
            termCount: 138,
          },
        ]),
      importGlossary: vi.fn(() => ok({ canceled: true })),
      exportGlossary: vi.fn(() => ok({ canceled: true })),
      credentialStatus: () =>
        ok({
          available: true,
          source: 'secure-storage',
          encryptionAvailable: true,
        }),
      getSessionStatus: () => ok({ active: false }),
      listRecordings: () => ok([]),
      listPendingMeetingRecords: () => ok([]),
      chooseMeetingRecordsDirectory: vi.fn(() =>
        ok({
          canceled: false,
          directory: 'C:\\Meetings',
          settings: { ...settings, meetingRecordsDirectory: 'C:\\Meetings' },
        }),
      ),
      openMeetingRecordsFolder: vi.fn(() => ok({ directory: 'C:\\Meetings' })),
      getMeetingRecordsUsage: vi.fn(() =>
        ok({ bytes: 1_400_000_000, sessionCount: 6, pendingBytes: 173_000_000 }),
      ),
      keepMeetingAudio: vi.fn((sessionId: string) =>
        ok({
          recording: true,
          sessionId,
          sessionDir: 'C:\\Meetings\\session',
          session: { sessionId, audioRetention: 'kept' as const },
        }),
      ),
      discardMeetingAudio: vi.fn((sessionId: string) =>
        ok({
          recording: true,
          sessionId,
          sessionDir: 'C:\\Meetings\\session',
          session: { sessionId, audioRetention: 'discarded' as const },
        }),
      ),
      revealMeetingRecord: vi.fn((sessionId: string) =>
        ok({ sessionId, sessionDir: 'C:\\Meetings\\session' }),
      ),
      exportMeetingRecord: vi.fn(() => ok({ canceled: true })),
      startSession: vi.fn(() => ok({})),
      stopSession: vi.fn(() => ok({})),
      setSettings: vi.fn((patch) => ok({ ...settings, ...patch })),
      setScreeningPrompt: (prompt) => ok(prompt),
      rateEvaluation: (rating) =>
        ok({
          ...rating,
          semanticScore: rating.semanticScore ?? null,
          flags: rating.flags ?? [],
          notes: rating.notes ?? '',
          ratedAt: Date.now(),
        }),
      abortShadow: () => ok({}),
      getPreviewVisibility: vi.fn(() =>
        ok({ overlaysVisible: false, cameraStageVisible: false }),
      ),
      getNativeCameraHealth: vi.fn(() =>
        ok({
          state: 'not-installed',
          supported: true,
          installed: false,
          windowsBuild: 26200,
          reason: 'not-installed',
          restartCount: 0,
          message: null,
          code: null,
        }),
      ),
      installNativeCamera: vi.fn(() =>
        ok({ state: 'stopped', supported: true, installed: true }),
      ),
      repairNativeCamera: vi.fn(() =>
        ok({ state: 'stopped', supported: true, installed: true }),
      ),
      removeNativeCamera: vi.fn(() =>
        ok({ state: 'not-installed', supported: true, installed: false }),
      ),
      retryNativeCamera: vi.fn(() =>
        ok({ state: 'starting', supported: true, installed: true }),
      ),
      showWindows: vi.fn(() =>
        ok({ overlaysVisible: true, cameraStageVisible: false }),
      ),
      hideWindows: vi.fn(() =>
        ok({ overlaysVisible: false, cameraStageVisible: false }),
      ),
      showCameraStage: vi.fn(() =>
        ok({ overlaysVisible: false, cameraStageVisible: true }),
      ),
      hideCameraStage: vi.fn(() =>
        ok({ overlaysVisible: false, cameraStageVisible: false }),
      ),
      setLayout: vi.fn((layout: 'stacked' | 'side-by-side') =>
        ok({ ...settings, layout }),
      ),
      exportSession: () => ok({ canceled: true }),
      validateCredential: () => ok({ valid: true }),
      requestMicrophoneAccess: vi.fn(() =>
        ok({ granted: true, status: 'granted' }),
      ),
      setCredential: () =>
        ok({
          available: true,
          source: 'secure-storage',
          encryptionAvailable: true,
        }),
      deleteCredential: () =>
        ok({
          available: false,
          source: 'missing',
          encryptionAvailable: true,
        }),
      repairCredential: vi.fn(() =>
        ok({
          available: false,
          source: 'missing',
          encryptionAvailable: true,
          canceled: true,
        }),
      ),
      openPrivacy: () => ok(undefined),
      sendAudio: () => {},
      supportsSystemAudio: () => Promise.resolve(false),
      listSystemAudioSources: () => Promise.resolve([]),
      connectSystemAudioSource: () => Promise.resolve(),
      disconnectSystemAudioSource: () => Promise.resolve(),
      checkScreenRecordingPermission: () =>
        Promise.resolve({ status: 'granted', platform: 'darwin' }),
      enableLoopbackAudio: () => Promise.resolve(),
      disableLoopbackAudio: () => Promise.resolve(),
      fixMonitorVolume: () => Promise.resolve(),
    };
  });

  it('integrates Start and Stop with elapsed time into the header pill', async () => {
    render(<ControlApp />);

    const startAction = await screen.findByRole('button', {
      name: /Start session/i,
    });
    expect(startAction).toHaveClass('session-pill');
    expect(screen.queryByText('Ready for a live meeting')).not.toBeInTheDocument();

    act(() => statusListener?.({ state: 'running' }));
    act(() => metricsListener?.({ elapsedMs: 168_000 }));

    const stopAction = await screen.findByRole('button', {
      name: /Stop session.*02:48/i,
    });
    expect(stopAction).toHaveClass('is-live');
    fireEvent.click(stopAction);
    await waitFor(() => expect(window.captions.stopSession).toHaveBeenCalledOnce());
  });

  it('offers the camera install from the readiness checklist and from Settings', async () => {
    // Two places, each with a distinct job: the readiness checklist fixes it
    // before starting, the Settings card manages it. Both use the same label. The
    // Audience view card no longer carries a third button with different copy.
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });
    fireEvent.click(screen.getByRole('button', { name: 'Virtual camera' }));

    expect(
      await screen.findByRole('heading', {
        name: /before captions can run|one thing worth doing/i,
      }),
    ).toBeInTheDocument();
    const install = await screen.findByRole('button', { name: 'Install camera' });
    expect(screen.getByText(/not listed as a camera in Teams or Zoom/i)).toBeInTheDocument();
    fireEvent.click(install);
    await waitFor(() =>
      expect(window.captions.installNativeCamera).toHaveBeenCalledOnce(),
    );

    act(() => {
      nativeCameraHealthListener?.({
        state: 'installed',
        supported: true,
        installed: true,
        message: null,
      });
    });
    expect(screen.getByText(/listed as a camera in your meeting app/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(
      await screen.findByRole('heading', { name: 'Native virtual camera' }),
    ).toBeInTheDocument();
    // Reinstall is offered even when installed: registering the filter is
    // idempotent and is the fix for a moved file or an app update.
    expect(screen.getByRole('button', { name: 'Reinstall camera' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove camera' })).toBeInTheDocument();
  });

  it('explains what is missing on a fresh install instead of just failing', async () => {
    // The day-one defect: Start is the most prominent control on the window, and
    // pressing it without a key simply did nothing. The blocker was on another tab
    // and nothing named it.
    window.captions.credentialStatus = () =>
      Promise.resolve({
        ok: true as const,
        data: { available: false, source: 'none', encryptionAvailable: true },
      });

    render(<ControlApp />);
    const startAction = await screen.findByRole('button', { name: /Start session/i });

    expect(
      screen.getByRole('heading', { name: /one step left before captions can run/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('Add your OpenAI API key')).toBeInTheDocument();
    expect(startAction).toBeDisabled();

    // The row's own button takes the operator to the fix rather than making them
    // discover which tab it lives on.
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }));
    expect(
      await screen.findByRole('heading', { name: 'Connection' }),
    ).toBeInTheDocument();
  });

  it('offers an explicit day/night switch that overrides the system', async () => {
    // The stylesheet had one dark trigger - prefers-color-scheme - so the operator
    // got whatever the OS was set to with no way to override it.
    window.localStorage.removeItem('captions.theme');
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    const dark = await screen.findByRole('button', { name: 'Dark' });
    fireEvent.click(dark);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('captions.theme')).toBe('dark');

    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(document.documentElement.dataset.theme).toBe('light');

    // System stays on offer rather than being replaced by a two-way switch.
    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(window.localStorage.getItem('captions.theme')).toBe('system');
  });

  it('restores a stored theme on launch', async () => {
    window.localStorage.setItem('captions.theme', 'dark');
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('reports what the recordings are actually using, not an estimate', async () => {
    // The card only ever stated a hypothetical - "two one-hour tracks can use about
    // 346 MB" - which says nothing about the meetings the operator has.
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    const usage = await screen.findByText(/1\.4 GB across 6 meetings/);
    // Pending audio is called out separately: it is the part still releasable by
    // answering the prompt.
    expect(usage.textContent).toMatch(/173 MB of audio still awaiting a decision/);
  });

  it('docks the primary action outside the scrolling content', async () => {
    // Start is the entry point to the whole app and used to scroll away with the
    // header. Fixed chrome, so the shell must also reserve its height - otherwise it
    // covers the last control on the page and nothing can reach it.
    // The reserved-space half of this contract is asserted in tokens.test.ts, which
    // reads the stylesheet; `import.meta.url` is an http URL under Vitest, so a test
    // here cannot read it from disk.
    render(<ControlApp />);
    const action = await screen.findByRole('button', { name: /Start session/i });
    expect(action.closest('.session-dock')).not.toBeNull();
    expect(action.closest('.app-header')).toBeNull();
  });

  it('does not convey channel status by colour alone', async () => {
    // Four pills in green/amber/red with a state name on them left a red-green
    // colourblind operator unable to tell a live channel from a dead one.
    audioMocks.start.mockResolvedValue({
      microphone: true,
      system: false,
      warning: 'Meeting audio is not being captured: check the output device.',
    });
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });
    fireEvent.click(screen.getByRole('button', { name: /Start session/i }));
    await screen.findByRole('button', { name: /Stop session/i });

    const badges = document.querySelectorAll('.channel-badge');
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      expect(
        badge.querySelector('svg'),
        `${badge.textContent} relies on colour alone`,
      ).not.toBeNull();
    }
  });

  it('hides the readiness checklist once nothing is outstanding', async () => {
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });
    // Default mocks: key present, a microphone enumerated, on-screen output. The
    // camera is not part of that path, so it must not be listed.
    expect(screen.queryByText('BEFORE YOU START')).not.toBeInTheDocument();
    expect(screen.queryByText('Install the virtual camera')).not.toBeInTheDocument();
  });

  it('keeps caption size beside visible history, not on another tab', async () => {
    // The two controls decide together how the audience reads a caption, and both
    // now sit under the preview that shows the result. Caption size used to be in
    // Settings, one tab away from its sibling.
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });

    expect(screen.getByLabelText('Caption size')).toBeInTheDocument();
    expect(screen.getByLabelText('Visible history')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('heading', { name: 'Connection' });
    expect(screen.queryByLabelText('Caption size')).not.toBeInTheDocument();
  });

  it('always offers a way to install the camera, even with no health report', async () => {
    // The reported defect: the whole card was gated on health.supported, so a
    // missing or failed health report hid every action and left no way to install
    // or repair the camera from the UI at all.
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(
      await screen.findByRole('heading', { name: 'Native virtual camera' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Install camera|Reinstall camera/ }))
      .toBeInTheDocument();
  });

  it('offers explicit meeting-record preferences and a native folder choice', async () => {
    render(<ControlApp />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));

    expect(screen.getByRole('heading', { name: 'Meeting records' })).toBeInTheDocument();
    expect(screen.getByLabelText('Auto-save transcript')).toBeChecked();
    expect(screen.getByLabelText('Keep audio automatically')).not.toBeChecked();
    expect(
      screen.getByText(/Microphone and meeting audio are temporarily recorded/),
    ).toBeInTheDocument();

    // "Choose folder…" is now "Change…", beside a new "Open folder". Reaching the
    // records folder previously required recording a meeting and then using Show in
    // folder on that one session.
    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }));
    await waitFor(() =>
      expect(window.captions.openMeetingRecordsFolder).toHaveBeenCalledOnce(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Change location…' }));
    await waitFor(() =>
      expect(window.captions.chooseMeetingRecordsDirectory).toHaveBeenCalledOnce(),
    );
    expect(await screen.findByText('C:\\Meetings')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Keep audio automatically'));
    await waitFor(() =>
      expect(window.captions.setSettings).toHaveBeenCalledWith({
        keepAudioAutomatically: true,
      }),
    );
  });

  it('shows backup disclosure during capture and a non-destructive meeting review after stop', async () => {
    window.captions.stopSession = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        data: {
          meetingRecord: {
            recording: true,
            sessionId: 'session-123',
            sessionDir: 'C:\\Meetings\\session',
            session: {
              sessionId: 'session-123',
              audioRetention: 'pending' as const,
              channelAvailability: { microphone: true, system: true },
            },
          },
        },
      }),
    );
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });

    fireEvent.click(screen.getByRole('button', { name: /Start session/i }));
    expect(
      await screen.findByText('TEMPORARY AUDIO BACKUP · MICROPHONE + MEETING'),
    ).toBeInTheDocument();

    act(() => {
      backupStateListener?.({
        channel: 'system',
        state: 'degraded',
        reason: 'queue_saturated',
        droppedMs: 100,
      });
    });
    expect(screen.getByText('BACKUP PAUSED · DISK TOO SLOW')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Stop session/i }));
    // The heading now asks the question the card exists to ask, instead of
    // announcing "Meeting saved" while the decision hid in the body text.
    expect(
      await screen.findByRole('heading', { name: "Keep this meeting's audio?" }),
    ).toBeInTheDocument();
    expect(screen.getByText('C:\\Meetings\\session')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Keep audio' }));
    await waitFor(() =>
      expect(window.captions.keepMeetingAudio).toHaveBeenCalledWith('session-123'),
    );
    expect(screen.getByRole('heading', { name: 'Audio kept' })).toBeInTheDocument();
  });

  it('requires a second click before deleting audio permanently', async () => {
    // Deletion is irreversible with no undo, which is the one case that earns a
    // confirmation. Inline rather than a modal so the flow is not broken, and the
    // destructive action no longer wears the most muted style on the card.
    window.captions.listPendingMeetingRecords = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        data: [
          {
            recording: true,
            sessionId: 'pending-1',
            sessionDir: 'C:\\Meetings\\pending',
            session: {
              sessionId: 'pending-1',
              audioRetention: 'pending' as const,
              channelAvailability: { microphone: true, system: true },
            },
          },
        ],
      }),
    ) as typeof window.captions.listPendingMeetingRecords;

    render(<ControlApp />);
    const arm = await screen.findByRole('button', { name: 'Delete audio' });

    fireEvent.click(arm);
    expect(window.captions.discardMeetingAudio).not.toHaveBeenCalled();

    // Backing out must be possible, and must leave the decision unmade.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(window.captions.discardMeetingAudio).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete audio' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete audio' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() =>
      expect(window.captions.discardMeetingAudio).toHaveBeenCalledWith('pending-1'),
    );
  });

  it('asks about every undecided meeting in one prompt', async () => {
    // The prompt used to render records[0] and drop the rest, so an operator who ended
    // one meeting and started the next built an invisible backlog while believing they
    // had answered everything.
    const pending = (id: string, startedAt: number) => ({
      recording: true,
      sessionId: id,
      session: {
        sessionId: id,
        startedAt,
        endedAt: startedAt + 10 * 60_000,
        audioRetention: 'pending' as const,
        channelAvailability: { microphone: true, system: true },
      },
    });
    window.captions.listPendingMeetingRecords = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        data: [pending('newest', 3_000_000), pending('older', 2_000_000), pending('oldest', 1_000_000)],
      }),
    ) as typeof window.captions.listPendingMeetingRecords;

    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });

    // The first is asked about by the main card; the other two are listed with it,
    // not queued for future launches.
    expect(await screen.findByText(/2 earlier meetings also undecided/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep all 2' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Keep all 2' }));
    await waitFor(() =>
      expect(window.captions.keepMeetingAudio).toHaveBeenCalledWith('older'),
    );
    expect(window.captions.keepMeetingAudio).toHaveBeenCalledWith('oldest');
  });

  it('arms before deleting the whole backlog', async () => {
    const pending = (id: string, startedAt: number) => ({
      recording: true,
      sessionId: id,
      session: {
        sessionId: id,
        startedAt,
        audioRetention: 'pending' as const,
        channelAvailability: { microphone: true, system: false },
      },
    });
    window.captions.listPendingMeetingRecords = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        data: [pending('a', 3_000), pending('b', 2_000)],
      }),
    ) as typeof window.captions.listPendingMeetingRecords;

    render(<ControlApp />);
    const arm = await screen.findByRole('button', { name: 'Delete all' });
    fireEvent.click(arm);
    // Bulk deletion is the most destructive control in the app; one click must not do it.
    expect(window.captions.discardMeetingAudio).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Delete all 1 permanently/ }));
    await waitFor(() =>
      expect(window.captions.discardMeetingAudio).toHaveBeenCalledWith('b'),
    );
  });

  it('states the cost of keeping before the decision is made', async () => {
    // Duration, caption count and disk size were all in the manifest and shown
    // nowhere; the only size guidance was a generic footnote in Settings.
    window.captions.listPendingMeetingRecords = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        data: [
          {
            recording: true,
            sessionId: 'sized-1',
            session: {
              sessionId: 'sized-1',
              startedAt: 1_000_000,
              endedAt: 1_000_000 + 30 * 60_000,
              captionCount: 84,
              audioRetention: 'pending' as const,
              channelAvailability: { microphone: true, system: true },
            },
          },
        ],
      }),
    ) as typeof window.captions.listPendingMeetingRecords;

    render(<ControlApp />);
    // 30 min x 2 tracks x 48 KB/s = 172.8 MB.
    const facts = await screen.findByText(/30 minutes/);
    expect(facts.textContent).toMatch(/84 captions/);
    expect(facts.textContent).toMatch(/173 MB if kept/);
  });

  it('restores pending audio decisions and labels original and audience text', async () => {
    window.captions.listPendingMeetingRecords = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        data: [
          {
            recording: true,
            sessionId: 'recovered-1',
            sessionDir: 'C:\\Meetings\\recovered',
            session: {
              sessionId: 'recovered-1',
              startedAt: Date.now() - 60_000,
              audioRetention: 'pending' as const,
              channelAvailability: { microphone: true, system: false },
            },
          },
        ],
      }),
    );
    render(<ControlApp />);

    expect(
      await screen.findByRole('heading', {
        name: 'Keep the audio from the meeting that was interrupted?',
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start session/i })).toBeDisabled();
    // Copy now says what is already safe and what each choice does, rather than
    // "choose whether to keep or permanently discard the encrypted microphone and
    // meeting audio backup" - eight words of implementation for a thing the operator
    // thinks of as "the recording".
    expect(screen.getByText(/The transcript is saved either way/i)).toBeVisible();
    expect(screen.getByText(/deleting it cannot be undone/i)).toBeVisible();

    act(() => {
      captionListener?.({
        id: 'caption-1',
        sessionId: 'recovered-1',
        sequence: 1,
        sourceChannel: 'microphone',
        sourceText: 'Confirm T2.',
        sourceLanguage: 'en',
        status: 'final',
        english: {
          text: 'Confirm T2.',
          status: 'final',
          revision: 1,
          passthrough: true,
        },
        chinese: {
          text: '确认 T2。',
          status: 'final',
          revision: 1,
          passthrough: false,
        },
      });
    });
    expect(screen.getByText('YOU · MICROPHONE')).toBeInTheDocument();
    expect(screen.getByText('ORIGINAL · ENGLISH')).toBeInTheDocument();
    expect(screen.getByText('ENGLISH VIEW')).toBeInTheDocument();
    expect(screen.getByText('中文视图')).toBeInTheDocument();
  });

  it('starts a focused live session without hidden evaluation work', async () => {
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });

    fireEvent.click(screen.getByRole('button', { name: /Start session/i }));

    await waitFor(() =>
      expect(window.captions.startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'live',
          screeningPrompt: null,
          settings: expect.objectContaining({
            shadowEnabled: false,
            recordEvaluation: false,
          }),
        }),
      ),
    );
  });

  it('keeps an end control available while starting and across transport events', async () => {
    let finishStart: ((value: { ok: true; data: Record<string, never> }) => void) | undefined;
    window.captions.startSession = vi.fn(
      (): ReturnType<typeof window.captions.startSession> =>
        new Promise((resolve) => {
          finishStart = resolve;
        }),
    );
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });

    fireEvent.click(screen.getByRole('button', { name: /Start session/i }));
    expect(screen.getByRole('button', { name: /Stop session/i })).toBeEnabled();

    act(() => statusListener?.({ state: 'connected' }));
    expect(screen.getByRole('button', { name: /Stop session/i })).toBeEnabled();

    await waitFor(() => expect(finishStart).toBeTypeOf('function'));
    await act(async () => {
      finishStart?.({ ok: true, data: {} });
    });
    await screen.findByRole('button', { name: /Stop session/i });
  });

  it('keeps an end control available while a channel is degraded or reconnecting', async () => {
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });
    fireEvent.click(screen.getByRole('button', { name: /Start session/i }));
    await screen.findByRole('button', { name: /Stop session/i });

    for (const state of ['degraded', 'reconnecting', 'budget-warning', 'running']) {
      act(() => statusListener?.({ state, message: `${state} on system` }));
      expect(screen.getByRole('button', { name: /Stop session/i })).toBeEnabled();
    }
  });

  it('flushes audio capture before asking the main process to stop', async () => {
    let finishAudioStop: (() => void) | undefined;
    audioMocks.stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishAudioStop = resolve;
        }),
    );
    render(<ControlApp />);
    fireEvent.click(await screen.findByRole('button', { name: /Start session/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Stop session/i }));

    await waitFor(() => expect(finishAudioStop).toBeTypeOf('function'));
    expect(window.captions.stopSession).not.toHaveBeenCalled();

    await act(async () => finishAudioStop?.());
    await waitFor(() => expect(window.captions.stopSession).toHaveBeenCalledOnce());
  });

  it('continues microphone captions and explains a failed meeting capture', async () => {
    audioMocks.start.mockResolvedValue({
      microphone: true,
      system: false,
      warning:
        'Microphone captions are live. Meeting audio is not being captured: confirm Windows is playing the meeting through an active output device, then end and restart the session.',
    });
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });

    fireEvent.click(screen.getByRole('button', { name: /Start session/i }));

    const warning = await screen.findByText(/Meeting audio is not being captured/);
    // Asserted on the enclosing live region rather than the text node's own element:
    // the warning carries a leading icon, so the text sits in a child of the element
    // that holds role="alert". What matters is that the text is announced.
    const announced = warning.closest('[role="alert"]');
    expect(announced).not.toBeNull();
    expect(announced!.textContent).not.toMatch(/Screen Recording/);
    // The session keeps running on the microphone alone.
    expect(screen.getByRole('button', { name: /Stop session/i })).toBeEnabled();
    expect(channelBadge('Meeting / system')).toBe('UNAVAILABLE');
  });

  it('survives dismissing the transient notice without losing the capture warning', async () => {
    audioMocks.start.mockResolvedValue({
      microphone: true,
      system: false,
      warning: 'Meeting audio is not being captured: check the output device.',
    });
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });
    fireEvent.click(screen.getByRole('button', { name: /Start session/i }));
    await screen.findByText(/Meeting audio is not being captured/);

    act(() => statusListener?.({ state: 'degraded', message: 'system reconnecting' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));

    expect(screen.getByText(/Meeting audio is not being captured/)).toBeVisible();
    expect(channelBadge('Meeting / system')).toBe('UNAVAILABLE');
  });

  it('never labels the meeting channel live before any audio has moved', async () => {
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });
    fireEvent.click(screen.getByRole('button', { name: /Start session/i }));
    await screen.findByRole('button', { name: /Stop session/i });

    act(() =>
      metricsListener?.({
        levels: { microphone: 0.08, system: 0 },
        transport: {
          microphone: { sentAudioMs: 4800, droppedAudioMs: 0, pendingChunks: 0, bufferedBytes: 0 },
          system: { sentAudioMs: 0, droppedAudioMs: 0, pendingChunks: 0, bufferedBytes: 0 },
        },
      }),
    );

    // Microphone is carrying audio; the meeting channel has produced nothing.
    expect(channelBadge('You / microphone')).toBe('LIVE');
    expect(channelBadge('Meeting / system')).toBe('STARTING');

    act(() =>
      metricsListener?.({
        transport: {
          system: { sentAudioMs: 2400, droppedAudioMs: 0, pendingChunks: 0, bufferedBytes: 0 },
        },
      }),
    );
    expect(channelBadge('Meeting / system')).toBe('LIVE');
  });

  it('clears capture state when the session ends', async () => {
    audioMocks.start.mockResolvedValue({
      microphone: true,
      system: false,
      warning: 'Meeting audio is not being captured: check the output device.',
    });
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });
    fireEvent.click(screen.getByRole('button', { name: /Start session/i }));
    await screen.findByText(/Meeting audio is not being captured/);

    fireEvent.click(screen.getByRole('button', { name: /Stop session/i }));

    await waitFor(() =>
      expect(
        screen.queryByText(/Meeting audio is not being captured/),
      ).not.toBeInTheDocument(),
    );
    expect(channelBadge('Meeting / system')).toBeNull();
  });

  it('persists a 3-10 entry visible-history setting without a pace delay', async () => {
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });

    expect(screen.queryByRole('slider', { name: 'Caption pace' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('slider', { name: 'Visible history' }), {
      target: { value: '10' },
    });

    await waitFor(() =>
      expect(window.captions.setSettings).toHaveBeenCalledWith({
        captionHistoryEntries: 10,
      }),
    );
    expect(screen.getByText('10 entries')).toBeVisible();
  });

  it('shows layout changes in the audience preview', async () => {
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });
    const preview = screen.getByText('English audience caption').parentElement;
    expect(preview).toHaveClass('overlay-preview--stacked');

    fireEvent.click(screen.getByRole('button', { name: 'Side by side' }));
    await waitFor(() =>
      expect(preview).toHaveClass('overlay-preview--side-by-side'),
    );
  });

  it('keeps projection layout controls usable in virtual-camera mode', async () => {
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });

    fireEvent.click(screen.getByRole('button', { name: 'Virtual camera' }));
    await screen.findByRole('button', { name: 'Stacked' });

    expect(screen.getByRole('button', { name: 'Stacked' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Side by side' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Side by side' }));
    await waitFor(() =>
      expect(window.captions.setLayout).toHaveBeenCalledWith('side-by-side'),
    );
    expect(screen.getByRole('button', { name: 'Side by side' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('switches between lower thirds and the virtual-camera stage', async () => {
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });

    expect(
      screen.getByRole('button', { name: 'On-screen captions' }),
    ).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(
      screen.getByRole('button', { name: 'Virtual camera' }),
    );
    await waitFor(() =>
      expect(window.captions.setSettings).toHaveBeenCalledWith({
        outputMode: 'virtual-camera',
      }),
    );
    expect(window.captions.showCameraStage).not.toHaveBeenCalled();
    expect(window.captions.hideWindows).not.toHaveBeenCalled();
    expect(screen.getByText(/capture the Twinscript Camera Stage/i)).toBeVisible();

    fireEvent.click(
      screen.getByRole('button', { name: 'On-screen captions' }),
    );
    await waitFor(() =>
      expect(window.captions.setSettings).toHaveBeenCalledWith({
        outputMode: 'overlays',
      }),
    );
    expect(window.captions.hideCameraStage).not.toHaveBeenCalled();
    expect(window.captions.showWindows).not.toHaveBeenCalled();
  });

  it('uses one stateful audience preview action synchronized with native windows', async () => {
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });

    const preview = await screen.findByRole('button', { name: 'Preview' });
    fireEvent.click(preview);
    await waitFor(() => expect(window.captions.showWindows).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Hide preview' })).toBeVisible();

    act(() =>
      previewVisibilityListener?.({
        overlaysVisible: false,
        cameraStageVisible: false,
      }),
    );
    expect(screen.getByRole('button', { name: 'Preview' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Virtual camera' }));
    await waitFor(() =>
      expect(window.captions.setSettings).toHaveBeenCalledWith({
        outputMode: 'virtual-camera',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() =>
      expect(window.captions.showCameraStage).toHaveBeenCalled(),
    );
    expect(screen.getByRole('button', { name: 'Hide preview' })).toBeVisible();
  });

  it('offers three distinct paired caption themes and persists the selected theme', async () => {
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });

    expect(screen.getByRole('button', { name: 'Blueprint theme' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    for (const label of ['Blueprint', 'Graphite', 'Red / Blue']) {
      expect(
        screen.getByRole('button', { name: `${label} theme` }),
      ).toBeVisible();
    }
    expect(screen.queryByRole('button', { name: 'Steel theme' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Red / Blue theme' }));
    await waitFor(() =>
      expect(window.captions.setSettings).toHaveBeenCalledWith({
        captionTheme: 'red-blue',
      }),
    );
  });

  it('keeps evaluation-era controls out of the product interface', async () => {
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });

    expect(screen.queryByText(/Phase 1/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/screening/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/corpus/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Demo/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Replay/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Compare/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByText(/Caption Quality/i)).toBeVisible();
    // "Save this meeting" moved out of Settings: saving is a per-meeting action,
    // not durable configuration, so it now sits under the transcript it saves.
    // Settings keeps only the policy — whether to auto-save, and where.
    expect(screen.queryByText('Save this meeting')).not.toBeInTheDocument();
    expect(screen.getByText('Meeting records')).toBeVisible();
    expect(screen.queryByText(/validation/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/shadow/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/evaluation/i)).not.toBeInTheDocument();
  });

  it('requests microphone access and starts a visible input preview', async () => {
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });
    fireEvent.click(screen.getByRole('button', { name: 'Test audio' }));

    await screen.findByText(/Both channels are live/);
    expect(window.captions.requestMicrophoneAccess).toHaveBeenCalled();
    // The system callback must be passed: without it the meeting meter cannot
    // move during a test, which is exactly the defect this covers.
    expect(audioMocks.previewStart).toHaveBeenCalledWith(
      'mic-1',
      expect.any(Function),
      expect.any(Function),
    );
    expect(screen.getByRole('button', { name: 'Retest audio' })).toBeVisible();
  });

  it('warns when the meeting channel cannot be captured during a test', async () => {
    audioMocks.previewStart.mockImplementationOnce(
      async (_deviceId: string, onLevel: (level: number) => void) => {
        onLevel(0.04);
        return {
          microphone: true,
          system: false,
          warning: 'System audio capture is unavailable on this device.',
        };
      },
    );
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });
    fireEvent.click(screen.getByRole('button', { name: 'Test audio' }));

    // A silent zero meter is what sent a previous investigation after a
    // non-existent bug; a failed loopback now says so.
    await screen.findByText(/System audio capture is unavailable/);
    expect(
      screen.getByText(/remote speech will not be transcribed separately/),
    ).toBeVisible();
  });

  it('shows one universal engineering glossary with advanced controls intact', async () => {
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(screen.queryByRole('combobox', { name: 'Meeting type' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Engineering glossary' })).toBeVisible();
    expect(screen.getByText(/T1, T2, EVT, DVT, and PVT stay in English/)).toBeVisible();
    expect(screen.getByText(/138 built-in terms/)).toBeVisible();
    expect(screen.getByText(/5 protected tokens/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Import glossary' })).toBeVisible();
    expect(screen.getByText(/Advanced .* Custom terms and protected tokens/)).toBeVisible();
  });

  it('keeps custom glossary editing behind an advanced disclosure', async () => {
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    const details = screen
      .getByText('Advanced · Custom terms and protected tokens')
      .closest('details');
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Advanced · Custom terms and protected tokens'));
    expect(details).toHaveAttribute('open');
    expect(screen.getByRole('textbox', { name: 'Custom bilingual overrides' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Additional protected tokens' })).toBeVisible();
  });

  it('invokes native glossary import and export actions', async () => {
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    fireEvent.click(screen.getByRole('button', { name: 'Import glossary' }));
    await waitFor(() => expect(window.captions.importGlossary).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Export configuration' }));
    await waitFor(() => expect(window.captions.exportGlossary).toHaveBeenCalled());
  });

  it('offers a scoped secure-storage repair only after an unlock failure', async () => {
    window.captions.validateCredential = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        error: {
          code: 'credential_unlock_failed',
          message: 'The saved API key could not be unlocked from macOS Keychain.',
        },
      }),
    );
    render(<ControlApp />);
    await screen.findByRole('button', { name: /Start session/i });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(
      screen.queryByRole('button', { name: 'Repair secure storage' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test saved key' }));

    const repair = await screen.findByRole('button', {
      name: 'Repair secure storage',
    });
    expect(screen.getByText('Saved key is locked')).toBeVisible();
    fireEvent.click(repair);
    await waitFor(() =>
      expect(window.captions.repairCredential).toHaveBeenCalledOnce(),
    );
  });
});
