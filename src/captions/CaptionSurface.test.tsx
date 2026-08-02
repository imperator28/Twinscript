import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptionSurface } from './CaptionSurface';
import type { AudienceCaption } from './types';

describe('CaptionSurface', () => {
  const hideWindows = vi.fn().mockResolvedValue({ ok: true });
  const reportCaptionContentHeight = vi.fn().mockResolvedValue({ ok: true });
  let audienceListener: ((caption: AudienceCaption) => void) | undefined;
  let statusListener:
    | ((status: { state: string; sessionId?: string }) => void)
    | undefined;
  let settingsListener:
    | ((settings: Record<string, unknown>) => void)
    | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
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
      getSettings: () =>
        Promise.resolve({
          ok: true,
          data: {
            captionFontScale: 1,
            captionHistoryEntries: 6,
            captionTheme: 'blueprint',
          },
        }),
      hideWindows,
      reportCaptionContentHeight,
    } as unknown as typeof window.captions;
  });

  it('offers a visible, accessible control that hides both overlays', () => {
    render(<CaptionSurface audience="en" />);

    fireEvent.click(screen.getByRole('button', { name: 'Hide caption windows' }));
    expect(hideWindows).toHaveBeenCalledOnce();
  });

  it('exposes a dedicated drag affordance across the caption header', () => {
    const { container } = render(<CaptionSurface audience="en" />);
    expect(container.querySelector('.caption-surface__header')).toBeTruthy();
    expect(container.querySelector('.caption-surface__drag-handle')).toBeTruthy();
  });

  it('also hides both overlays with Escape', () => {
    render(<CaptionSurface audience="zh" />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(hideWindows).toHaveBeenCalledOnce();
  });

  it('distinguishes pending translation from a real failure', () => {
    render(<CaptionSurface audience="zh" />);
    const caption: AudienceCaption = {
      id: 'caption',
      sessionId: 'session',
      sequence: 1,
      sourceChannel: 'microphone',
      sourceText: 'A live English prefix',
      sourceLanguage: 'en',
      audience: 'zh',
      text: '',
      status: 'pending',
      settled: false,
      revision: 0,
      passthrough: false,
      sourceStartedAt: 1,
    };

    act(() => audienceListener?.(caption));
    expect(screen.getByText('正在翻译…')).toBeInTheDocument();

    act(() =>
      audienceListener?.({
        ...caption,
        status: 'failed',
        settled: true,
        revision: 1,
        error: { code: 'normalization_failed', message: 'Translation unavailable' },
      }),
    );
    expect(screen.getByText('翻译暂不可用')).toBeInTheDocument();
  });

  it('retains the configured number of complete entries and revises provisional speech in place', async () => {
    const { container } = render(<CaptionSurface audience="en" />);
    await act(async () => {});
    act(() =>
      settingsListener?.({
        captionFontScale: 1,
        captionHistoryEntries: 3,
      }),
    );

    const caption = (
      sequence: number,
      status: AudienceCaption['status'],
    ): AudienceCaption => ({
      id: `caption-${sequence}`,
      sessionId: 'session',
      sequence,
      sourceChannel: 'microphone',
      sourceText: `Source ${sequence}`,
      sourceLanguage: 'en',
      audience: 'en',
      text: `Caption ${sequence}`,
      status,
      settled: status === 'final' || status === 'failed',
      revision: 1,
      passthrough: true,
      sourceStartedAt: sequence,
    });

    act(() => {
      for (let sequence = 1; sequence <= 5; sequence += 1) {
        audienceListener?.(caption(sequence, 'final'));
      }
    });
    expect(container.querySelectorAll('.caption-line')).toHaveLength(3);
    expect(screen.queryByText('Caption 2')).not.toBeInTheDocument();
    expect(screen.getByText('Caption 5')).toBeInTheDocument();

    act(() => audienceListener?.(caption(6, 'provisional')));
    expect(container.querySelectorAll('.caption-line')).toHaveLength(4);
    act(() =>
      audienceListener?.({
        ...caption(6, 'provisional'),
        text: 'Caption 6 revised',
        revision: 2,
      }),
    );
    expect(container.querySelectorAll('.caption-line')).toHaveLength(4);
    expect(screen.queryByText('Caption 6')).not.toBeInTheDocument();
    expect(screen.getByText('Caption 6 revised')).toBeInTheDocument();

    const oldest = container.querySelector<HTMLElement>('.caption-line');
    expect(Number(oldest?.style.opacity)).toBeGreaterThanOrEqual(0.42);
  });

  it('reveals retained captions when visible history increases', async () => {
    render(<CaptionSurface audience="en" />);
    await act(async () => {});
    const caption = (sequence: number): AudienceCaption => ({
      id: `line-${sequence}`,
      sessionId: 'session',
      sequence,
      sourceChannel: 'microphone',
      sourceText: `Source ${sequence}`,
      sourceLanguage: 'en',
      audience: 'en',
      text: `Line ${sequence}`,
      status: 'final',
      settled: true,
      revision: 1,
      passthrough: true,
      sourceStartedAt: sequence,
    });

    act(() => settingsListener?.({ captionHistoryEntries: 3 }));
    act(() => {
      for (let sequence = 1; sequence <= 10; sequence += 1) {
        audienceListener?.(caption(sequence));
      }
    });
    expect(screen.queryByText('Line 1')).not.toBeInTheDocument();

    act(() => settingsListener?.({ captionHistoryEntries: 10 }));
    expect(await screen.findByText('Line 1')).toBeInTheDocument();
  });

  it('focuses every in-flight caption and the two newest settled captions', () => {
    const { container } = render(<CaptionSurface audience="en" />);
    const caption = (
      sequence: number,
      status: AudienceCaption['status'],
      settled: boolean,
    ): AudienceCaption => ({
      id: `caption-${sequence}`,
      sessionId: 'session',
      sequence,
      sourceChannel: 'microphone',
      sourceText: `Source ${sequence}`,
      sourceLanguage: 'en',
      audience: 'en',
      text: `Caption ${sequence}`,
      status,
      settled,
      revision: 1,
      passthrough: true,
      sourceStartedAt: sequence,
    });

    act(() => {
      audienceListener?.(caption(1, 'final', true));
      audienceListener?.(caption(2, 'final', true));
      audienceListener?.(caption(3, 'final', true));
      audienceListener?.(caption(4, 'final', false));
      audienceListener?.(caption(5, 'pending', false));
    });

    expect(screen.getByText('Caption 1').closest('.caption-line')).toHaveClass(
      'is-history',
    );
    for (const sequence of [2, 3, 4, 5]) {
      expect(
        screen.getByText(`Caption ${sequence}`).closest('.caption-line'),
      ).toHaveClass('is-focused');
    }
    expect(container.querySelectorAll('.caption-line.is-focused')).toHaveLength(4);
  });

  it('clears at a new session boundary and ignores late captions from the old session', () => {
    render(<CaptionSurface audience="en" />);
    const caption = (sessionId: string, id: string): AudienceCaption => ({
      id,
      sessionId,
      sequence: 1,
      sourceChannel: 'system',
      sourceText: id,
      sourceLanguage: 'en',
      audience: 'en',
      text: id,
      status: 'final',
      settled: true,
      revision: 1,
      passthrough: true,
      sourceStartedAt: 1,
    });

    act(() => statusListener?.({ state: 'starting', sessionId: 'session-a' }));
    act(() => audienceListener?.(caption('session-a', 'first session')));
    expect(screen.getByText('first session')).toBeInTheDocument();

    act(() => statusListener?.({ state: 'starting', sessionId: 'session-b' }));
    expect(screen.queryByText('first session')).not.toBeInTheDocument();
    act(() => audienceListener?.(caption('session-a', 'late old caption')));
    expect(screen.queryByText('late old caption')).not.toBeInTheDocument();
    act(() => audienceListener?.(caption('session-b', 'fresh session')));
    expect(screen.getByText('fresh session')).toBeInTheDocument();
  });

  it('measures natural inner content with the current auto-size generation', async () => {
    let observed: Element | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        callback: ResizeObserverCallback;
        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }
        observe(element: Element) {
          observed = element;
          this.callback(
            [{ contentRect: { height: 123 } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
        disconnect() {}
        unobserve() {}
      },
    );
    window.captions.getSettings = () =>
      Promise.resolve({
        ok: true,
        data: {
          captionFontScale: 1,
          captionHistoryEntries: 6,
          captionTheme: 'blueprint',
          captionAutoSizeGeneration: 4,
        },
      });

    const { container } = render(<CaptionSurface audience="en" />);
    await act(async () => {});

    expect(observed).toBe(container.querySelector('.caption-content'));
    expect(reportCaptionContentHeight).toHaveBeenLastCalledWith('en', 174, 4);
    vi.unstubAllGlobals();
  });

  it('applies semantic theme tokens for the selected audience', async () => {
    window.captions.getSettings = () =>
      Promise.resolve({
        ok: true,
        data: {
          captionFontScale: 1,
          captionHistoryEntries: 6,
          captionTheme: 'red-blue',
        },
      });
    const { container } = render(<CaptionSurface audience="zh" />);
    await act(async () => {});

    const surface = container.querySelector<HTMLElement>('.caption-surface');
    expect(surface?.style.getPropertyValue('--caption-background')).toBe(
      '#8B2635',
    );
    expect(surface?.style.getPropertyValue('--caption-primary')).toBe('#FFFFFF');
  });
});
