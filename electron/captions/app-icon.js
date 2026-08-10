const fs = require('node:fs');
const path = require('node:path');

/**
 * Where the window icon lives, in development and once packaged.
 *
 * `assets/` is deliberately NOT inside the asar - forge.config.js uses a
 * whitelist ignore that admits only package.json, dist-electron, build and
 * node_modules - so it ships through `extraResource` and lands beside the app at
 * `process.resourcesPath/assets`. A single relative path cannot reach it in both
 * layouts, which is why this exists rather than one `path.join` at the call site.
 *
 * Unpackaged, the root comes from `app.getAppPath()` rather than from `__dirname`.
 * That is not a style preference: this module is a declared build entry today, so
 * it lands at `dist-electron/captions/app-icon.js` and `../..` would reach the
 * repo - but drop the entry from vite.config.ts and rolldown inlines it into
 * `dist-electron/captions-main.js`, where the same expression resolves one level
 * ABOVE the repo. The build-entry guard does not catch that (it only tracks bare
 * `./sibling` requires), so the icon would quietly go missing with every test
 * still green. `getAppPath()` is where it is called from, not where it lives.
 *
 * Windows gets the `.ico`: it is the only container carrying the small sizes the
 * shell asks for (16-48px for the title bar, Alt-Tab and the taskbar at various
 * DPI), and handing Electron a single 512px PNG makes Windows downscale it once,
 * badly. Everything else takes the PNG - macOS ignores the BrowserWindow icon
 * entirely and uses the bundle's `.icns`.
 */
function appIconPath({
  platform = process.platform,
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  appPath = '',
  exists = fs.existsSync,
} = {}) {
  const file = platform === 'win32' ? 'icon.ico' : 'icon.png';
  // Packaged, assets/ sits beside the asar rather than inside it; unpackaged it is
  // in the app directory itself.
  const root = isPackaged ? resourcesPath : appPath;
  if (!root) return '';
  const candidate = path.join(root, 'assets', file);
  // A missing icon is not worth crashing over, but it must not be reported as a
  // path either: Electron given a nonexistent icon silently falls back to its own
  // default, which is how a wrong icon goes unnoticed. Returning '' lets the
  // caller omit the option and lets a test assert the difference.
  return exists(candidate) ? candidate : '';
}

module.exports = { appIconPath };
