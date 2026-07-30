import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlApp } from './ControlApp';

const audioMocks = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue({ microphone: true, system: true }),
  stop: vi.fn().mockResolvedValue(undefined),
  previewStart: vi.fn().mockImplementation(
    async (_deviceId: string, onLevel: (level: number) => void) => onLevel(0.04),
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

let statusListener: ((status: { state: string }) => void) | undefined;

const settings = {
  settingsVersion: 3,
  layout: 'stacked',
  primaryProfile: 'economy',
  shadowProfile: 'tiered',
  shadowEnabled: true,
  fastPath: true,
  provisionalTranslation: true,
  vadEnabled: true,
  vadThreshold: 0.012,
  delayProfile: 'low',
  budgetUsd: 5,
  glossary: [],
  captionFontScale: 1,
  captionPaceMs: 1200,
  showSourceInControl: true,
  recordEvaluation: false,
  recordingRetentionDays: 7,
  reorderWindowMs: 400,
  duplicateWindowMs: 1400,
};

describe('Phase 1 screening shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statusListener = undefined;
    const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
    window.captions = {
      onStatus: (callback) => {
        statusListener = callback;
        return () => {};
      },
      onMetrics: () => () => {},
      onCaption: () => () => {},
      onEvaluation: () => () => {},
      onAudienceCaption: () => () => {},
      onLayout: () => () => {},
      onSettings: () => () => {},
      getSettings: () => ok(settings),
      credentialStatus: () =>
        ok({
          available: true,
          source: 'secure-storage',
          encryptionAvailable: true,
        }),
      getSessionStatus: () => ok({ active: false }),
      listRecordings: () => ok([]),
      startSession: vi.fn(() => ok({})),
      stopSession: () => ok({}),
      setSettings: vi.fn((patch) => ok(patch)),
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
      showWindows: () => ok(undefined),
      hideWindows: () => ok(undefined),
      setLayout: () => ok({ layout: 'stacked' }),
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

  it('starts live capture with a stable screening prompt', async () => {
    render(<ControlApp />);
    await screen.findByText('Ready for a live meeting');
    fireEvent.click(screen.getByLabelText('Use corpus'));
    expect(screen.getByText(/256 consent-safe prompts/)).toBeInTheDocument();
    expect(screen.getByText('1 / 256')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Start Live Session' }));

    await waitFor(() =>
      expect(window.captions.startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'live',
          screeningPrompt: expect.objectContaining({
            id: expect.any(String),
            scripted: true,
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
    await screen.findByText('Ready for a live meeting');

    fireEvent.click(screen.getByRole('button', { name: 'Start Live Session' }));
    expect(screen.getByRole('button', { name: 'Stop Session' })).toBeEnabled();

    act(() => statusListener?.({ state: 'connected' }));
    expect(screen.getByRole('button', { name: 'Stop Session' })).toBeEnabled();

    await waitFor(() => expect(finishStart).toBeTypeOf('function'));
    await act(async () => {
      finishStart?.({ ok: true, data: {} });
    });
    await screen.findByRole('button', { name: 'Stop Session' });
  });

  it('persists a live-adjustable caption presentation pace', async () => {
    render(<ControlApp />);
    await screen.findByText('Ready for a live meeting');

    fireEvent.change(screen.getByRole('slider', { name: 'Caption pace' }), {
      target: { value: '2200' },
    });

    await waitFor(() =>
      expect(window.captions.setSettings).toHaveBeenCalledWith({
        captionPaceMs: 2200,
      }),
    );
    expect(screen.getByText('Relaxed · 2.2s')).toBeVisible();
  });

  it('shows layout changes in the audience preview', async () => {
    render(<ControlApp />);
    await screen.findByText('Ready for a live meeting');
    const preview = screen.getByText('English audience caption').parentElement;
    expect(preview).toHaveClass('overlay-preview--stacked');

    fireEvent.click(screen.getByRole('button', { name: 'Side by side' }));
    await waitFor(() =>
      expect(preview).toHaveClass('overlay-preview--side-by-side'),
    );
  });

  it('requests microphone access and starts a visible input preview', async () => {
    render(<ControlApp />);
    await screen.findByText('Ready for a live meeting');
    fireEvent.click(screen.getByRole('button', { name: 'Test microphone' }));

    await screen.findByText(/Microphone is active/);
    expect(window.captions.requestMicrophoneAccess).toHaveBeenCalled();
    expect(audioMocks.previewStart).toHaveBeenCalledWith(
      'mic-1',
      expect.any(Function),
    );
    expect(screen.getByRole('button', { name: 'Retest microphone' })).toBeVisible();
  });
});
