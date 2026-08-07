// Local UI preferences: the small pieces of state this window keeps in localStorage
// rather than in the settings file.
//
// They are listed in one place so a reset cannot silently miss one. Three keys have
// accumulated across features, each added next to the code that reads it, and a reset
// written by hand would clear whichever the author happened to remember.

import { THEME_STORAGE_KEY } from './theme';

export const READINESS_DISMISSED_KEY = 'captions.readinessDismissed';
export const SECURE_STORAGE_REPAIRED_KEY = 'captions.secureStorageRepaired';

/**
 * Everything a reset clears.
 *
 * Deliberately NOT included, because they are not local UI preferences and losing them
 * would be a real loss rather than a fresh start:
 *   - the API key, which lives in the OS credential store
 *   - the glossary, budget, caption theme and records policy, which live in the settings
 *     file and are the operator's actual configuration
 *   - saved meetings and their audio
 *   - the installed virtual camera, which is machine-wide and needs elevation to change
 */
export const LOCAL_PREFERENCE_KEYS = [
  READINESS_DISMISSED_KEY,
  SECURE_STORAGE_REPAIRED_KEY,
  THEME_STORAGE_KEY,
] as const;

/**
 * Clear the keys above. Returns the ones that were actually set, so the UI can report
 * what changed rather than claiming a reset that did nothing.
 */
export function resetLocalPreferences(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
): string[] {
  const cleared: string[] = [];
  for (const key of LOCAL_PREFERENCE_KEYS) {
    // Checked before removing so the report is accurate; removeItem on an absent key is
    // silent and would otherwise look identical to clearing a real value.
    if (storage.getItem(key) !== null) cleared.push(key);
    storage.removeItem(key);
  }
  return cleared;
}
