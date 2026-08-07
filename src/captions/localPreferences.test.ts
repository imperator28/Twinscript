import { describe, expect, it } from 'vitest';

import {
  LOCAL_PREFERENCE_KEYS,
  READINESS_DISMISSED_KEY,
  SECURE_STORAGE_REPAIRED_KEY,
  resetLocalPreferences,
} from './localPreferences';
import { THEME_STORAGE_KEY } from './theme';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    removeItem: (key: string) => void data.delete(key),
  };
}

describe('LOCAL_PREFERENCE_KEYS', () => {
  it('covers every key this window writes', () => {
    // Listed in one place so a reset cannot silently miss one. If a feature adds a key,
    // this is the test that should fail.
    expect([...LOCAL_PREFERENCE_KEYS].sort()).toEqual(
      [READINESS_DISMISSED_KEY, SECURE_STORAGE_REPAIRED_KEY, THEME_STORAGE_KEY].sort(),
    );
  });

  it('contains no key belonging to real configuration', () => {
    // The API key, glossary, budget and meeting records are not local UI preferences, and
    // clearing them would be a loss rather than a fresh start.
    for (const key of LOCAL_PREFERENCE_KEYS) {
      expect(key).not.toMatch(/glossary|credential|budget|record|meeting/i);
    }
  });
});

describe('resetLocalPreferences', () => {
  it('clears every listed key', () => {
    const storage = fakeStorage({
      [READINESS_DISMISSED_KEY]: '1',
      [THEME_STORAGE_KEY]: 'dark',
      [SECURE_STORAGE_REPAIRED_KEY]: '1',
    });
    resetLocalPreferences(storage);
    expect(storage.data.size).toBe(0);
  });

  it('reports only the keys that were actually set', () => {
    // So the UI can say what changed instead of claiming a reset that did nothing.
    const storage = fakeStorage({ [THEME_STORAGE_KEY]: 'light' });
    expect(resetLocalPreferences(storage)).toEqual([THEME_STORAGE_KEY]);
  });

  it('reports nothing when there was nothing to clear', () => {
    expect(resetLocalPreferences(fakeStorage())).toEqual([]);
  });

  it('leaves unrelated keys alone', () => {
    // Another surface's state, or anything a future feature stores, must survive.
    const storage = fakeStorage({
      [THEME_STORAGE_KEY]: 'dark',
      'sokuji_onboarding_completed': 'true',
      'something.else': 'keep me',
    });
    resetLocalPreferences(storage);
    expect(storage.getItem('sokuji_onboarding_completed')).toBe('true');
    expect(storage.getItem('something.else')).toBe('keep me');
  });

  it('is safe to run twice', () => {
    const storage = fakeStorage({ [READINESS_DISMISSED_KEY]: '1' });
    expect(resetLocalPreferences(storage)).toHaveLength(1);
    expect(resetLocalPreferences(storage)).toEqual([]);
  });
});
