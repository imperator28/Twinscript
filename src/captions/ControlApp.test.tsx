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
  settingsVersion: 5,
  layout: 'stacked',
  primaryProfile: 'economy',
  shadowProfile: 'tiered',
  shadowEnabled: false,
  fastPath: true,
  provisionalTranslation: true,
  vadEnabled: true,
  vadThreshold: 0.012,
  delayProfile: 'low',
  budgetUsd: 5,
  glossaryConfigurationId: 'south-china-tooling',
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
  glossaryStoredCount: 38,
  captionFontScale: 1,
  captionPaceMs: 1200,
  showSourceInControl: true,
  recordEvaluation: false,
  recordingRetentionDays: 7,
  reorderWindowMs: 400,
  duplicateWindowMs: 1400,
};

describe('meeting caption controls', () => {
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
      getGlossaryConfigurations: () =>
        ok([
          {
            id: 'mechanical-product-design',
            name: 'Mechanical & Product Design',
            description: 'CAD and drawing review.',
            regions: [],
            domains: ['mechanical design'],
            termCount: 36,
          },
          {
            id: 'south-china-tooling',
            name: 'South China Tooling & Supplier Meetings',
            description: 'Guangdong tooling and supplier terminology.',
            regions: ['Guangdong', 'Shenzhen', 'Dongguan'],
            domains: ['tooling'],
            termCount: 38,
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
      startSession: vi.fn(() => ok({})),
      stopSession: () => ok({}),
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

  it('starts a focused live session without hidden evaluation work', async () => {
    render(<ControlApp />);
    await screen.findByText('Ready for a live meeting');

    fireEvent.click(screen.getByRole('button', { name: 'Start Session' }));

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
    await screen.findByText('Ready for a live meeting');

    fireEvent.click(screen.getByRole('button', { name: 'Start Session' }));
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

  it('keeps evaluation-era controls out of the product interface', async () => {
    render(<ControlApp />);
    await screen.findByText('Ready for a live meeting');

    expect(screen.queryByText(/Phase 1/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/screening/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/corpus/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Demo/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Replay/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Compare/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByText(/Caption Quality/i)).toBeVisible();
    expect(screen.getByText('Save this meeting')).toBeVisible();
    expect(screen.queryByText(/validation/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/shadow/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/evaluation/i)).not.toBeInTheDocument();
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

  it('uses a configuration-first glossary with product terms protected', async () => {
    render(<ControlApp />);
    await screen.findByText('Ready for a live meeting');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(
      screen.getByRole('combobox', { name: 'Meeting type' }),
    ).toHaveValue('south-china-tooling');
    expect(screen.getByText(/T1, T2, EVT, DVT, and PVT stay in English/)).toBeVisible();
    expect(screen.getByText(/1 active/)).toBeVisible();
    expect(screen.getByText(/38 stored/)).toBeVisible();
    expect(screen.getByText(/5 protected tokens/)).toBeVisible();

    fireEvent.change(screen.getByRole('combobox', { name: 'Meeting type' }), {
      target: { value: 'mechanical-product-design' },
    });
    await waitFor(() =>
      expect(window.captions.setSettings).toHaveBeenCalledWith({
        glossaryConfigurationId: 'mechanical-product-design',
      }),
    );
  });

  it('keeps custom glossary editing behind an advanced disclosure', async () => {
    render(<ControlApp />);
    await screen.findByText('Ready for a live meeting');
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
    await screen.findByText('Ready for a live meeting');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    fireEvent.click(screen.getByRole('button', { name: 'Import glossary' }));
    await waitFor(() => expect(window.captions.importGlossary).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Export configuration' }));
    await waitFor(() => expect(window.captions.exportGlossary).toHaveBeenCalled());
  });
});
