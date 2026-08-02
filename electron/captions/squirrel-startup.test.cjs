const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  APP_USER_MODEL_ID,
  SQUIRREL_PACKAGE_NAME,
  SQUIRREL_EXECUTABLE_NAME,
  UPDATE_TIMEOUT_MS,
  applyAppUserModelId,
  handleSquirrelStartup,
} = require('./squirrel-startup');

const silentLogger = { info() {}, error() {} };

function harness({ argv, platform = 'win32', spawnImpl } = {}) {
  const spawned = [];
  const timers = [];
  let quits = 0;
  let nativeCameraCleanups = 0;
  const child = {
    handlers: {},
    once(event, handler) {
      this.handlers[event] = handler;
      return this;
    },
    unref() {
      this.unreffed = true;
      return this;
    },
  };
  const consumed = handleSquirrelStartup({
    argv,
    platform,
    execPath: 'C:\\Users\\dev\\AppData\\Local\\Twinscript\\app-0.1.0\\twinscript.exe',
    spawn:
      spawnImpl ||
      ((command, args, options) => {
        spawned.push({ command, args, options });
        return child;
      }),
    quit: () => {
      quits += 1;
    },
    setTimeoutImpl: (handler, delay) => {
      timers.push({ handler, delay });
      return { unref() {} };
    },
    logger: silentLogger,
    cleanupNativeCamera: () => {
      nativeCameraCleanups += 1;
    },
  });
  return {
    consumed,
    spawned,
    timers,
    child,
    quits: () => quits,
    nativeCameraCleanups: () => nativeCameraCleanups,
  };
}

test('an ordinary launch is not treated as a Squirrel event', () => {
  const run = harness({ argv: ['C:\\app\\twinscript.exe'] });
  assert.equal(run.consumed, false);
  assert.equal(run.spawned.length, 0);
  assert.equal(run.quits(), 0);
});

test('the first launch after installation keeps running', () => {
  const run = harness({
    argv: ['C:\\app\\twinscript.exe', '--squirrel-firstrun'],
  });
  assert.equal(run.consumed, false);
  assert.equal(run.quits(), 0);
});

test('installation creates a shortcut for the installed executable and exits', () => {
  const run = harness({
    argv: ['C:\\app\\twinscript.exe', '--squirrel-install'],
  });
  assert.equal(run.consumed, true);
  assert.equal(run.spawned.length, 1);
  assert.equal(
    run.spawned[0].command,
    'C:\\Users\\dev\\AppData\\Local\\Twinscript\\Update.exe',
  );
  assert.deepEqual(run.spawned[0].args, [
    '--createShortcut',
    'twinscript.exe',
  ]);
  // The process must not exit before Update.exe has written the shortcut.
  assert.equal(run.quits(), 0);
  run.child.handlers.close();
  assert.equal(run.quits(), 1);
});

test('an update refreshes the shortcut rather than removing it', () => {
  const run = harness({
    argv: ['C:\\app\\twinscript.exe', '--squirrel-updated'],
  });
  assert.equal(run.consumed, true);
  assert.deepEqual(run.spawned[0].args, [
    '--createShortcut',
    'twinscript.exe',
  ]);
});

test('uninstallation removes the shortcut and exits', () => {
  const run = harness({
    argv: ['C:\\app\\twinscript.exe', '--squirrel-uninstall'],
  });
  assert.equal(run.consumed, true);
  assert.deepEqual(run.spawned[0].args, [
    '--removeShortcut',
    'twinscript.exe',
  ]);
  assert.equal(run.nativeCameraCleanups(), 1);
});

test('uninstall records a failed native-camera cleanup instead of silently ignoring it', () => {
  const errors = [];
  handleSquirrelStartup({
    argv: ['C:\\app\\client.exe', '--squirrel-uninstall'],
    platform: 'win32',
    execPath: 'C:\\app\\client.exe',
    cleanupNativeCamera: () => false,
    spawn: () => ({ once() { return this; }, unref() {} }),
    quit() {},
    setTimeoutImpl: () => ({ unref() {} }),
    logger: { info() {}, error: (...args) => errors.push(args) },
  });
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /cleanup failed/i);
});

test('install, update, and ordinary launches never request native-camera removal', () => {
  for (const event of [undefined, '--squirrel-install', '--squirrel-updated']) {
    const argv = ['C:\\app\\twinscript.exe'];
    if (event) argv.push(event);
    const run = harness({ argv });
    assert.equal(run.nativeCameraCleanups(), 0, String(event));
  }
});

test('an obsolete version exits without touching shortcuts', () => {
  const run = harness({
    argv: ['C:\\app\\twinscript.exe', '--squirrel-obsolete'],
  });
  assert.equal(run.consumed, true);
  assert.equal(run.spawned.length, 0);
  assert.equal(run.quits(), 1);
});

test('a stalled Update.exe still exits on the bounded fallback', () => {
  const run = harness({
    argv: ['C:\\app\\twinscript.exe', '--squirrel-install'],
  });
  assert.equal(run.timers.length, 1);
  assert.equal(run.timers[0].delay, UPDATE_TIMEOUT_MS);
  run.timers[0].handler();
  assert.equal(run.quits(), 1);
  // The later close event must not double-quit.
  run.child.handlers.close();
  assert.equal(run.quits(), 1);
});

test('a missing Update.exe does not leave the installer process running', () => {
  const run = harness({
    argv: ['C:\\app\\twinscript.exe', '--squirrel-install'],
    spawnImpl: () => {
      throw new Error('ENOENT');
    },
  });
  assert.equal(run.consumed, true);
  assert.equal(run.quits(), 1);
});

test('a failed Update.exe launch exits once', () => {
  const run = harness({
    argv: ['C:\\app\\twinscript.exe', '--squirrel-install'],
  });
  run.child.handlers.error(new Error('EACCES'));
  assert.equal(run.quits(), 1);
  run.child.handlers.close();
  assert.equal(run.quits(), 1);
});

test('Squirrel arguments are ignored on macOS and Linux', () => {
  for (const platform of ['darwin', 'linux']) {
    const run = harness({
      argv: ['/Applications/App', '--squirrel-install'],
      platform,
    });
    assert.equal(run.consumed, false);
    assert.equal(run.spawned.length, 0);
  }
});

test('the Windows taskbar identity is set only on Windows', () => {
  const calls = [];
  const app = { setAppUserModelId: (id) => calls.push(id) };
  assert.equal(applyAppUserModelId({ app, platform: 'win32' }), APP_USER_MODEL_ID);
  assert.deepEqual(calls, [APP_USER_MODEL_ID]);

  assert.equal(applyAppUserModelId({ app, platform: 'darwin' }), null);
  assert.deepEqual(calls, [APP_USER_MODEL_ID]);
});

test('the taskbar identity matches the Squirrel maker configuration', () => {
  const forgeConfig = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'forge.config.js'),
    'utf8',
  );
  assert.match(forgeConfig, new RegExp(`name: '${SQUIRREL_PACKAGE_NAME}'`));
  assert.match(forgeConfig, new RegExp(`exe: '${SQUIRREL_EXECUTABLE_NAME}\\.exe'`));
  assert.equal(
    APP_USER_MODEL_ID,
    `com.squirrel.${SQUIRREL_PACKAGE_NAME}.${SQUIRREL_EXECUTABLE_NAME}`,
  );
});

test('the caption main process consumes Squirrel events before creating windows', () => {
  const main = fs.readFileSync(
    path.resolve(__dirname, '..', 'captions-main.js'),
    'utf8',
  );
  const squirrelIndex = main.indexOf('handleSquirrelStartup({');
  const initMainIndex = main.indexOf('initMain()');
  const readyIndex = main.indexOf('app.whenReady()');
  assert.ok(squirrelIndex > 0, 'captions-main.js must handle Squirrel startup');
  assert.ok(
    squirrelIndex < initMainIndex,
    'Squirrel handling must run before audio loopback initialization',
  );
  assert.ok(
    squirrelIndex < readyIndex,
    'Squirrel handling must run before the ready handler is registered',
  );
  assert.match(
    main,
    /if \(consumedBySquirrel\) return;/,
    'the ready handler must bail out on a Squirrel launch',
  );
  assert.match(
    main,
    /applyAppUserModelId\(\{ app \}\)/,
    'captions-main.js must declare the Squirrel AppUserModelID',
  );
});
