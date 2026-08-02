// Control-window lifecycle rules.
//
// The two audience windows intercept `close` and hide themselves so the
// operator can dismiss captions without ending a session. That means Electron's
// `window-all-closed` never fires while they exist, so closing the control
// window alone does not end the app.
//
// On macOS that is correct: the app stays in the dock and `activate` recreates
// the control window. On Windows and Linux it is a defect — the caption windows
// set `skipTaskbar`, so the control window is the app's only taskbar entry and
// closing it leaves an unreachable process holding the microphone and loopback
// capture open.

/**
 * Whether closing the control window should end the app.
 */
function shouldQuitOnControlWindowClose(platform = process.platform) {
  return platform !== 'darwin';
}

/**
 * Wire the platform-appropriate reaction to the control window closing.
 *
 * `onClosed` runs first on every platform so the caller can drop its reference
 * before the app decides whether to quit.
 */
function registerControlWindowLifecycle({
  app,
  controlWindow,
  platform = process.platform,
  onClosed,
}) {
  controlWindow.on('closed', () => {
    onClosed?.();
    if (shouldQuitOnControlWindowClose(platform)) app.quit();
  });
  return controlWindow;
}

module.exports = {
  registerControlWindowLifecycle,
  shouldQuitOnControlWindowClose,
};
