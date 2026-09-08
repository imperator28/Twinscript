import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
