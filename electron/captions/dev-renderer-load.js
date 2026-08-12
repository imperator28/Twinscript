/**
 * Load a renderer URL that may not be listening yet.
 *
 * `npm run dev` launches Electron from `vite-plugin-electron`'s `onstart` as soon
 * as the MAIN-process build finishes. The renderer dev server is a separate,
 * slower startup - measured at ~21 seconds on this repository after the
 * dependency tree changed - so the first `loadURL` regularly loses the race and
 * fails with ERR_CONNECTION_REFUSED.
 *
 * Every window did `void window.loadURL(...)`: one attempt, result discarded. A
 * lost race was therefore permanent. Combined with the control window being
 * created `show: false` and revealed only on `ready-to-show`, which cannot fire
 * for a page that never loaded, the visible outcome was an app with no window at
 * all - or, if the camera stage happened to be open, nothing but its near-black
 * background. That is the "app is blank" report, and it recurred because nothing
 * about it was retried, logged, or surfaced.
 *
 * Retrying is the whole fix. The dev server always arrives; the code just has to
 * still be asking.
 */
function loadDevRendererUrl({
  window,
  url,
  delayMs = 400,
  // ~60 seconds at the default delay. Long enough for a cold Vite start on a
  // slow machine, bounded so a genuinely wrong URL does not spin forever.
  maxAttempts = 150,
  schedule = setTimeout,
  onGiveUp = null,
}) {
  let attempts = 0;

  const attempt = () => {
    if (!window || (typeof window.isDestroyed === 'function' && window.isDestroyed())) {
      return;
    }
    attempts += 1;
    // `loadURL` rejects on failure. The previous code discarded that promise,
    // which is why nothing anywhere reported the failure.
    Promise.resolve(window.loadURL(url)).catch((error) => {
      if (attempts >= maxAttempts) {
        if (onGiveUp) onGiveUp(error, attempts);
        return;
      }
      schedule(attempt, delayMs);
    });
  };

  attempt();
  return () => attempts;
}

module.exports = { loadDevRendererUrl };
