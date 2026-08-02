// Squirrel.Windows lifecycle handling for the caption client.
//
// Squirrel launches the installed executable with a single `--squirrel-*`
// argument during install, update, and uninstall. Those launches must create
// shortcuts and exit; if the app treats them as an ordinary start it flashes a
// duplicate control window during installation and leaves a stray process
// behind. Nothing here may depend on `app.whenReady()` — the check runs before
// any window, audio, or credential work.
//
// The Squirrel application identity is derived from the maker configuration in
// forge.config.js (`name` + `exe`). Squirrel registers shortcuts under this
// AppUserModelID, so the running process must declare the same value or Windows
// pins and taskbar groups split into two entries.

const path = require('path');
const { spawn: defaultSpawn } = require('child_process');

const SQUIRREL_PACKAGE_NAME = 'Twinscript';
const SQUIRREL_EXECUTABLE_NAME = 'twinscript';
const APP_USER_MODEL_ID = `com.squirrel.${SQUIRREL_PACKAGE_NAME}.${SQUIRREL_EXECUTABLE_NAME}`;

// `--squirrel-firstrun` is deliberately absent: it marks the first ordinary
// launch after installation and the app must keep running.
const SHORTCUT_EVENTS = new Set(['--squirrel-install', '--squirrel-updated']);
const REMOVE_EVENTS = new Set(['--squirrel-uninstall']);
const QUIT_ONLY_EVENTS = new Set(['--squirrel-obsolete']);

const UPDATE_TIMEOUT_MS = 5000;

/**
 * Set the Windows taskbar identity to the one Squirrel installs shortcuts
 * under. A no-op on macOS and Linux.
 */
function applyAppUserModelId({ app, platform = process.platform } = {}) {
  if (platform !== 'win32' || typeof app?.setAppUserModelId !== 'function') {
    return null;
  }
  app.setAppUserModelId(APP_USER_MODEL_ID);
  return APP_USER_MODEL_ID;
}

/**
 * Consume a Squirrel lifecycle launch.
 *
 * Returns `true` when the process exists only to service Squirrel, in which
 * case the caller must return immediately without creating windows. Returns
 * `false` for an ordinary launch, including `--squirrel-firstrun`.
 */
function handleSquirrelStartup({
  argv = process.argv,
  platform = process.platform,
  execPath = process.execPath,
  spawn = defaultSpawn,
  quit,
  setTimeoutImpl = setTimeout,
  logger = console,
  cleanupNativeCamera,
} = {}) {
  if (platform !== 'win32') return false;

  const event = argv.find((argument) => String(argument).startsWith('--squirrel-'));
  if (!event) return false;

  const shortcutArgument = SHORTCUT_EVENTS.has(event)
    ? '--createShortcut'
    : REMOVE_EVENTS.has(event)
      ? '--removeShortcut'
      : null;

  if (REMOVE_EVENTS.has(event)) {
    try {
      const cleaned = cleanupNativeCamera?.();
      if (cleanupNativeCamera && cleaned !== true) {
        logger.error(
          '[Twinscript] Native camera cleanup failed; use Repair/Remove after reinstall to clear an orphaned registration.',
        );
      }
    } catch (error) {
      // Do not strand the app uninstall if the optional camera was never
      // installed or Windows approval is declined. The registration cleanup
      // remains available from the explicit Remove camera action.
      logger.error(
        '[Twinscript] Native camera cleanup failed:',
        error,
      );
    }
  }

  if (!shortcutArgument && !QUIT_ONLY_EVENTS.has(event)) {
    // An unrecognized `--squirrel-*` argument (notably `--squirrel-firstrun`)
    // is an ordinary launch.
    return false;
  }

  let quitted = false;
  const quitOnce = () => {
    if (quitted) return;
    quitted = true;
    quit();
  };

  if (!shortcutArgument) {
    logger.info(`[Twinscript] Squirrel ${event}: exiting.`);
    quitOnce();
    return true;
  }

  const appFolder = path.resolve(execPath, '..');
  const updateExe = path.resolve(appFolder, '..', 'Update.exe');
  const exeName = path.basename(execPath);
  logger.info(
    `[Twinscript] Squirrel ${event}: ${shortcutArgument} ${exeName}`,
  );

  try {
    const child = spawn(updateExe, [shortcutArgument, exeName], {
      detached: true,
      stdio: 'ignore',
    });
    // Exit once Update.exe finishes so the shortcut write completes, but never
    // hang an installer step on it.
    child?.once?.('close', quitOnce);
    child?.once?.('error', (error) => {
      logger.error(
        '[Twinscript] Squirrel Update.exe failed:',
        error,
      );
      quitOnce();
    });
    child?.unref?.();
    const timer = setTimeoutImpl(quitOnce, UPDATE_TIMEOUT_MS);
    timer?.unref?.();
  } catch (error) {
    logger.error(
      '[Twinscript] Squirrel Update.exe could not be started:',
      error,
    );
    quitOnce();
  }

  return true;
}

module.exports = {
  APP_USER_MODEL_ID,
  SQUIRREL_PACKAGE_NAME,
  SQUIRREL_EXECUTABLE_NAME,
  UPDATE_TIMEOUT_MS,
  applyAppUserModelId,
  handleSquirrelStartup,
};
