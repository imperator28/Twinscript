import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraStage } from './CameraStage';
import type { Audience, AudienceCaption, SessionStatus } from './types';

describe('CameraStage', () => {
  let audienceListener: ((caption: AudienceCaption) => void) | undefined;
  let statusListener: ((status: SessionStatus) => void) | undefined;
  let settingsListener:
    | ((settings: Record<string, unknown>) => void)
    | undefined;

  const caption = (
    sequence: number,
    audience: Audience,
    options: Partial<AudienceCaption> = {},
  ): AudienceCaption => ({
    id: `caption-${sequence}`,
    sessionId: 'session-a',
    sequence,
    sourceChannel: sequence % 2 ? 'microphone' : 'system',
    sourceText: `Source ${sequence}`,
    sourceLanguage: 'en',
    audience,
    text: audience === 'en' ? `English ${sequence}` : `中文 ${sequence}`,
    status: 'final',
    settled: true,
    revision: 1,
    passthrough: audience === 'en',
    sourceStartedAt: sequence,
    ...options,
  });

  beforeEach(() => {
    audienceListener = undefined;
    statusListener = undefined;
    settingsListener = undefined;
    window.captions = {
      onAudienceCaption: (callback) => {
        audienceListener = callback;
        return () => {};
      },
      onStatus: (callback) => {
        statusListener = callback;
        return () => {};
      },
      onSettings: (callback) => {
        settingsListener = callback;
        return () => {};
      },
      getSettings: vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          data: {
            captionHistoryEntries: 6,
            captionTheme: 'blueprint',
          },
        }),
      ),
      getCameraStageSnapshot: vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          data: { status: { state: 'ready' }, captions: [] },
        }),
      ),
      hideCameraStage: vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          data: { overlaysVisible: false, cameraStageVisible: false },
        }),
      ),
    } as unknown as typeof window.captions;
  });

  it('hydrates the active session when opened after captions already started', async () => {
    window.captions.getCameraStageSnapshot = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        data: {
          status: { state: 'running', sessionId: 'session-a' },
          captions: [caption(1, 'en'), caption(1, 'zh')],
        },
      }),
    );

    render(<CameraStage />);

    expect(await screen.findByText('English 1')).toBeVisible();
    expect(screen.getByText('\u4e2d\u6587 1')).toBeVisible();
  });

  it('shows a privacy slate before the first session and after stop', () => {
    render(<CameraStage />);

    expect(screen.getByText('Bilingual captions ready')).toBeVisible();
    expect(screen.queryByText(/API|budget|cost/i)).not.toBeInTheDocument();

    act(() => statusListener?.({ state: 'running', sessionId: 'session-a' }));
    act(() => {
      audienceListener?.(caption(1, 'en'));
      audienceListener?.(caption(1, 'zh'));
    });
    expect(screen.getByText('English 1')).toBeVisible();

    act(() => statusListener?.({ state: 'stopped', sessionId: 'session-a' }));
    expect(screen.getByText('Bilingual captions ready')).toBeVisible();
    expect(screen.queryByText('English 1')).not.toBeInTheDocument();
  });

  it('hides the frameless camera stage when Escape is pressed', () => {
    render(<CameraStage />);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(window.captions.hideCameraStage).toHaveBeenCalledOnce();
  });

  it('renders one shared entry only after both audience projections settle', () => {
    render(<CameraStage />);
    act(() => statusListener?.({ state: 'running', sessionId: 'session-a' }));

    act(() => audienceListener?.(caption(1, 'en')));
    expect(screen.queryByText('English 1')).not.toBeInTheDocument();

    act(() =>
      audienceListener?.(
        caption(1, 'zh', { settled: false, status: 'provisional' }),
      ),
    );
    expect(screen.queryByText('English 1')).not.toBeInTheDocument();

    act(() => audienceListener?.(caption(1, 'zh')));
    expect(screen.getByText('English 1')).toBeVisible();
    expect(screen.getByText('中文 1')).toBeVisible();
    expect(screen.getByText('YOU')).toBeVisible();
    expect(screen.getByText('你')).toBeVisible();
  });

  it('uses shared visible history and clears on a new session boundary', () => {
    const { container } = render(<CameraStage />);
    act(() => statusListener?.({ state: 'running', sessionId: 'session-a' }));
    act(() =>
      settingsListener?.({
        captionHistoryEntries: 3,
        captionTheme: 'blueprint',
      }),
    );
    act(() => {
      for (let sequence = 1; sequence <= 5; sequence += 1) {
        audienceListener?.(caption(sequence, 'en'));
        audienceListener?.(caption(sequence, 'zh'));
      }
    });
    expect(container.querySelectorAll('.camera-stage__entry')).toHaveLength(6);
    expect(screen.queryByText('English 2')).not.toBeInTheDocument();
    expect(screen.getByText('English 5')).toBeVisible();

    act(() => statusListener?.({ state: 'starting', sessionId: 'session-b' }));
    expect(screen.queryByText('English 5')).not.toBeInTheDocument();
    act(() => audienceListener?.(caption(6, 'en')));
    act(() => audienceListener?.(caption(6, 'zh')));
    expect(screen.queryByText('English 6')).not.toBeInTheDocument();
  });

  it('renders a fixed split surface without controls or private app state', async () => {
    const { container } = render(<CameraStage />);
    await act(async () => {});
    act(() =>
      statusListener?.({ state: 'running', sessionId: 'session-a' }),
    );

    const stage = container.querySelector<HTMLElement>('.camera-stage');
    expect(stage).toBeTruthy();
    expect(container.querySelectorAll('.camera-stage__audience')).toHaveLength(2);
    expect(screen.getByText('ENGLISH')).toBeVisible();
    expect(screen.getByText('中文')).toBeVisible();
    expect(stage?.style.getPropertyValue('--stage-en-background')).toBe(
      '#0D47A1',
    );
    expect(stage?.style.getPropertyValue('--stage-zh-background')).toBe(
      '#E3F2FD',
    );
    expect(container.querySelector('button, input, select, textarea, a')).toBeNull();
    expect(screen.queryByText(/credential|OpenAI|notification|settings/i)).not.toBeInTheDocument();
  });
});

describe('CameraStage operator chrome', () => {
  // Relative, so jsdom does not reject it as a cross-origin history update.
  const setRole = (role: string | null) => {
    const query = role
      ? `?surface=camera-stage&role=${role}`
      : '?surface=camera-stage';
    window.history.replaceState({}, '', query);
  };

  afterEach(() => setRole(null));

  it('offers a hide control on the preview surface', async () => {
    setRole('preview');
    render(<CameraStage />);
    await act(async () => {});

    const hide = screen.getByRole('button', { name: 'Hide preview' });
    expect(hide).toBeTruthy();
    fireEvent.click(hide);
    expect(window.captions.hideCameraStage).toHaveBeenCalled();
  });

  it('never renders chrome on the surface that becomes the camera feed', async () => {
    setRole('output');
    const { container } = render(<CameraStage />);
    await act(async () => {});

    expect(container.querySelector('.camera-stage__chrome')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('fails safe: a surface with no declared role shows no chrome', async () => {
    setRole(null);
    const { container } = render(<CameraStage />);
    await act(async () => {});

    expect(container.querySelector('.camera-stage__chrome')).toBeNull();
  });
});
