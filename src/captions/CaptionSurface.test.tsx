import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptionSurface } from './CaptionSurface';
import type { AudienceCaption } from './types';

describe('CaptionSurface', () => {
  const hideWindows = vi.fn().mockResolvedValue({ ok: true });
  let audienceListener: ((caption: AudienceCaption) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    audienceListener = undefined;
    window.captions = {
      onAudienceCaption: (callback) => {
        audienceListener = callback;
        return () => {};
      },
      onStatus: () => () => {},
      onSettings: () => () => {},
      getSettings: () =>
        Promise.resolve({
          ok: true,
          data: { captionFontScale: 1, captionPaceMs: 1200 },
        }),
      hideWindows,
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
        revision: 1,
        error: { code: 'normalization_failed', message: 'Translation unavailable' },
      }),
    );
    expect(screen.getByText('翻译暂不可用')).toBeInTheDocument();
  });
});
