import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptionSurface } from './CaptionSurface';

describe('CaptionSurface', () => {
  const hideWindows = vi.fn().mockResolvedValue({ ok: true });

  beforeEach(() => {
    vi.clearAllMocks();
    window.captions = {
      onAudienceCaption: () => () => {},
      onStatus: () => () => {},
      onSettings: () => () => {},
      getSettings: () =>
        Promise.resolve({ ok: true, data: { captionFontScale: 1 } }),
      hideWindows,
    } as unknown as typeof window.captions;
  });

  it('offers a visible, accessible control that hides both overlays', () => {
    render(<CaptionSurface audience="en" />);

    fireEvent.click(screen.getByRole('button', { name: 'Hide caption windows' }));
    expect(hideWindows).toHaveBeenCalledOnce();
  });

  it('also hides both overlays with Escape', () => {
    render(<CaptionSurface audience="zh" />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(hideWindows).toHaveBeenCalledOnce();
  });
});
