import { describe, expect, it, vi } from 'vitest';

import {
  THEME_STORAGE_KEY,
  applyPlatform,
  applyTheme,
  bindTheme,
  isThemePreference,
  readThemePreference,
  resolveTheme,
} from './theme';

/** Minimal MediaQueryList stand-in that can report and then flip. */
function fakeQuery(matches: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches,
    addEventListener: vi.fn((_: string, fn: () => void) => listeners.add(fn)),
    removeEventListener: vi.fn((_: string, fn: () => void) => listeners.delete(fn)),
    flip(next: boolean) {
      query.matches = next;
      listeners.forEach((fn) => fn());
    },
    get listenerCount() {
      return listeners.size;
    },
  };
  return query;
}

const matchMediaFor = (query: ReturnType<typeof fakeQuery>) =>
  vi.fn(() => query) as unknown as typeof window.matchMedia;

describe('resolveTheme', () => {
  it('follows the system only when the preference is system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('ignores the system for an explicit choice', () => {
    // The whole point of the control: a dimmed room does not become bright because
    // the OS thinks it is daytime.
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('readThemePreference', () => {
  it('defaults to following the system', () => {
    expect(readThemePreference({ getItem: () => null })).toBe('system');
    expect(readThemePreference(null)).toBe('system');
    expect(readThemePreference(undefined)).toBe('system');
  });

  it('restores a stored choice', () => {
    expect(readThemePreference({ getItem: () => 'dark' })).toBe('dark');
    expect(readThemePreference({ getItem: () => 'light' })).toBe('light');
  });

  it('falls back rather than trusting a corrupted value', () => {
    // localStorage is writable by anything in the renderer; a junk value must not
    // become a junk data-theme attribute that matches no stylesheet rule.
    expect(readThemePreference({ getItem: () => 'DARK' })).toBe('system');
    expect(readThemePreference({ getItem: () => 'midnight' })).toBe('system');
    expect(readThemePreference({ getItem: () => '' })).toBe('system');
  });

  it('reads the documented key', () => {
    const getItem = vi.fn(() => 'dark');
    readThemePreference({ getItem });
    expect(getItem).toHaveBeenCalledWith(THEME_STORAGE_KEY);
  });
});

describe('isThemePreference', () => {
  it('accepts only the three supported values', () => {
    expect(['system', 'light', 'dark'].every(isThemePreference)).toBe(true);
    for (const bad of ['auto', 'Dark', null, undefined, 0, {}]) {
      expect(isThemePreference(bad)).toBe(false);
    }
  });
});

describe('applyTheme', () => {
  it('stamps the attribute the stylesheet reads', () => {
    const root = document.createElement('html');
    applyTheme(root, 'dark');
    expect(root.dataset.theme).toBe('dark');
  });

  it('sets color-scheme so native controls follow', () => {
    // Without it a dark page keeps light scrollbars and light select popups.
    const root = document.createElement('html');
    applyTheme(root, 'dark');
    expect(root.style.colorScheme).toBe('dark');
    applyTheme(root, 'light');
    expect(root.style.colorScheme).toBe('light');
  });
});

describe('applyPlatform', () => {
  it('stamps the platform so the stylesheet can reserve OS chrome space', () => {
    const root = document.createElement('html');
    applyPlatform(root, 'darwin');
    expect(root.dataset.platform).toBe('darwin');
  });

  it('leaves the attribute unset when the preload did not supply one', () => {
    // Absent is meaningfully different from a guess: no attribute means the default
    // inset applies, rather than macOS's 50px traffic-light clearance on Windows.
    const root = document.createElement('html');
    applyPlatform(root, undefined);
    expect(root.dataset.platform).toBeUndefined();
    applyPlatform(root, '');
    expect(root.dataset.platform).toBeUndefined();
  });
});

describe('bindTheme', () => {
  it('applies immediately rather than waiting for a change event', () => {
    const root = document.createElement('html');
    const query = fakeQuery(true);
    bindTheme('system', { root, matchMedia: matchMediaFor(query) });
    expect(root.dataset.theme).toBe('dark');
  });

  it('tracks the OS while following the system', () => {
    const root = document.createElement('html');
    const query = fakeQuery(false);
    bindTheme('system', { root, matchMedia: matchMediaFor(query) });
    expect(root.dataset.theme).toBe('light');

    query.flip(true);
    expect(root.dataset.theme).toBe('dark');
  });

  it('does not listen at all for an explicit choice', () => {
    const root = document.createElement('html');
    const query = fakeQuery(true);
    bindTheme('light', { root, matchMedia: matchMediaFor(query) });
    expect(root.dataset.theme).toBe('light');
    expect(query.listenerCount).toBe(0);

    query.flip(false);
    expect(root.dataset.theme).toBe('light');
  });

  it('stops tracking once torn down', () => {
    const root = document.createElement('html');
    const query = fakeQuery(false);
    const stop = bindTheme('system', { root, matchMedia: matchMediaFor(query) });
    stop();
    expect(query.listenerCount).toBe(0);

    query.flip(true);
    expect(root.dataset.theme).toBe('light');
  });

  it('survives an environment with no matchMedia', () => {
    // A missing matchMedia means "cannot detect dark", not "throw during render".
    const root = document.createElement('html');
    expect(() =>
      bindTheme('system', { root, matchMedia: undefined }),
    ).not.toThrow();
    expect(root.dataset.theme).toBe('light');
    // An explicit choice must still be honoured without it.
    bindTheme('dark', { root, matchMedia: undefined });
    expect(root.dataset.theme).toBe('dark');
  });

  it('returns a teardown even when it never subscribed', () => {
    const root = document.createElement('html');
    expect(() => bindTheme('dark', { root, matchMedia: undefined })()).not.toThrow();
  });
});
