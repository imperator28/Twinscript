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
 * In development `__dirname` is `dist-electron/`, so the repo's `assets/` is one
 * level up.
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
  moduleDirectory = __dirname,
  exists = fs.existsSync,
} = {}) {
  const file = platform === 'win32' ? 'icon.ico' : 'icon.png';
  const root = isPackaged
    ? resourcesPath
    : // dist-electron/captions -> dist-electron -> repo root
      path.join(moduleDirectory, '..', '..');
  if (!root) return '';
  const candidate = path.join(root, 'assets', file);
  // A missing icon is not worth crashing over, but it must not be reported as a
  // path either: Electron given a nonexistent icon silently falls back to its own
  // default, which is how a wrong icon goes unnoticed. Returning '' lets the
  // caller omit the option and lets a test assert the difference.
  return exists(candidate) ? candidate : '';
}

module.exports = { appIconPath };
