// Day/night mode for the control window.
//
// The stylesheet previously had exactly one dark trigger - `prefers-color-scheme` -
// so the operator got whatever the OS was set to and could not override it. That is
// a poor default for this app in particular: the control window is often the only
// bright thing on a desk during a dimmed presentation, and the OS theme is a weak
// proxy for what the room needs right now.
//
// Resolution happens here rather than in CSS so there is a single dark token block to
// maintain instead of one per trigger. `applyTheme` stamps the resolved value on the
// root element and the stylesheet keys off that alone.

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'captions.theme';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** Falls back to following the OS for anything unrecognised or absent. */
export function readThemePreference(
  storage: Pick<Storage, 'getItem'> | null | undefined,
): ThemePreference {
  const stored = storage?.getItem(THEME_STORAGE_KEY);
  return isThemePreference(stored) ? stored : 'system';
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

/**
 * Stamps the resolved theme on the root element. The stylesheet reads
 * `:root[data-theme="dark"]`, so an explicit choice and a system choice arrive
 * through the same channel and cannot disagree.
 */
export function applyTheme(root: HTMLElement, theme: ResolvedTheme): void {
  root.dataset.theme = theme;
  // Keeps native form controls and scrollbars in step with the surface; without it a
  // dark page keeps light native widgets.
  root.style.colorScheme = theme;
}

/**
 * Stamps the host platform so the stylesheet can reserve space for whatever chrome
 * the OS draws above the content. Taken from the preload rather than the user agent:
 * the main process already branches on platform to pick the title-bar style, and two
 * independent answers to that question can disagree.
 */
export function applyPlatform(
  root: HTMLElement,
  platform: string | undefined,
): void {
  if (platform) root.dataset.platform = platform;
}

/**
 * Binds a preference to the document and keeps it in step with the OS while the
 * preference is `system`. Returns a teardown that removes the listener.
 */
export function bindTheme(
  preference: ThemePreference,
  {
    root = document.documentElement,
    matchMedia = typeof window !== 'undefined' ? window.matchMedia : undefined,
  }: { root?: HTMLElement; matchMedia?: typeof window.matchMedia } = {},
): () => void {
  // jsdom and older webviews do not always provide matchMedia. A missing one means
  // "cannot detect dark", not "throw on import".
  const query =
    typeof matchMedia === 'function'
      ? matchMedia.call(window, '(prefers-color-scheme: dark)')
      : null;

  const sync = () =>
    applyTheme(root, resolveTheme(preference, Boolean(query?.matches)));
  sync();

  // Only worth listening while following the OS: an explicit light or dark choice
  // must not move when the system flips at sunset.
  if (preference !== 'system' || !query?.addEventListener) return () => {};
  query.addEventListener('change', sync);
  return () => query.removeEventListener('change', sync);
}
