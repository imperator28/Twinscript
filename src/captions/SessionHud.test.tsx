import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionHud } from './SessionHud';

describe('SessionHud', () => {
  beforeEach(() => {
    window.captions = {
      onStatus: () => () => {},
      onMetrics: () => () => {},
      onSessionHudDock: () => () => {},
      setSessionHudExpanded: vi.fn().mockResolvedValue({ ok: true, data: { expanded: false } }),
      stopSession: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    } as unknown as typeof window.captions;
  });

  it('renders the pill without throwing', () => {
    render(<SessionHud />);
    expect(document.querySelector('.session-hud')).not.toBeNull();
  });

  it('shows the elapsed clock collapsed', () => {
    render(<SessionHud />);
    expect(screen.getByText('0:00')).toBeVisible();
  });
});

describe('SessionHud resilience', () => {
  it('still renders its Stop path when a subscription throws', () => {
    // The preload's channel allowlist throws for a channel it does not know.
    // That took the whole surface into the error boundary once, and the error UI
    // overflows a 36px window - so the pill looked blank with a scrollbar. The
    // HUD must survive it, because Stop is the only reason the window exists.
    window.captions = {
      onStatus: () => () => {},
      onMetrics: () => () => {},
      onSessionHudDock: () => {
        throw new Error('Unsupported caption event subscription');
      },
      stopSession: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    } as unknown as typeof window.captions;

    render(<SessionHud />);
    expect(document.querySelector('.session-hud')).not.toBeNull();
    expect(screen.getByText('0:00')).toBeVisible();
  });

  it('renders with no preload bridge at all', () => {
    // Belt and braces: a window that loads before the bridge is ready must not
    // present a broken box.
    (window as unknown as { captions?: unknown }).captions = undefined;
    render(<SessionHud />);
    expect(document.querySelector('.session-hud')).not.toBeNull();
  });
});

describe('SessionHud expand and stop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reveals Stop on hover and keeps it through a resize-induced leave', async () => {
    // The reported bug: hovering expands the window, the resize moves its edge
    // out from under the cursor, Chromium fires pointerleave, the pill collapses
    // and resizes back, which fires pointerenter again. Stop flickered in and out
    // and could not be clicked.
    const stopSession = vi.fn().mockResolvedValue({ ok: true, data: {} });
    window.captions = {
      onStatus: () => () => {},
      onMetrics: () => () => {},
      onSessionHudDock: () => () => {},
      setSessionHudExpanded: vi.fn().mockResolvedValue({ ok: true, data: { expanded: true } }),
      stopSession,
    } as unknown as typeof window.captions;

    render(<SessionHud />);
    const pill = document.querySelector('.session-hud') as HTMLElement;

    fireEvent.pointerEnter(pill);
    const stopButton = screen.getByRole('button', { name: /Stop session/i });
    expect(stopButton).toBeVisible();

    // The spurious leave the resize causes, immediately followed by re-entry.
    fireEvent.pointerLeave(pill);
    fireEvent.pointerEnter(pill);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('button', { name: /Stop session/i })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /Stop session/i }));
    expect(stopSession).toHaveBeenCalledOnce();
  });

  it('collapses back once the pointer really leaves', () => {
    window.captions = {
      onStatus: () => () => {},
      onMetrics: () => () => {},
      onSessionHudDock: () => () => {},
      setSessionHudExpanded: vi.fn().mockResolvedValue({ ok: true, data: { expanded: false } }),
      stopSession: vi.fn(),
    } as unknown as typeof window.captions;

    render(<SessionHud />);
    const pill = document.querySelector('.session-hud') as HTMLElement;

    fireEvent.pointerEnter(pill);
    expect(screen.getByRole('button', { name: /Stop session/i })).toBeVisible();

    fireEvent.pointerLeave(pill);
    // Still open during the grace period, gone after it.
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole('button', { name: /Stop session/i })).not.toBeNull();
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('button', { name: /Stop session/i })).toBeNull();
  });
});
