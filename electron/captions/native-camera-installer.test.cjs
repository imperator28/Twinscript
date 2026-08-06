const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { NativeCameraInstaller } = require('./native-camera-installer');

function harness({ supported = true, exitCode = 0, existsSync = () => true } = {}) {
  const calls = [];
  const installer = new NativeCameraInstaller({
    support: { supported, reason: supported ? null : 'windows-11-required' },
    isPackaged: true,
    resourcesPath: 'C:\\app\\resources',
    existsSync,
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      process.nextTick(() => child.emit('close', exitCode, null));
      return child;
    },
  });
  return { installer, calls };
}

test('install and repair run only the explicit elevated lifecycle script', async () => {
  const { installer, calls } = harness();
  await installer.install();
  await installer.repair();

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(
      call.command,
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    assert.deepEqual(call.args.slice(0, 5), [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
    ]);
    // The DirectShow filter is the camera that ships. These actions previously ran
    // install-native-camera.ps1, which installs the Media Foundation source - a
    // camera that enumerates everywhere and renders a black feed in every meeting
    // client. Repairing to a broken camera is worse than offering no repair.
    assert.equal(
      call.args[5],
      'C:\\app\\resources\\native-camera\\register-dshow-camera.ps1',
    );
    assert.deepEqual(call.args.slice(6), [
      '-Action',
      'Install',
      // Explicit: when packaged, the script sits beside the DLL and its
      // dev-relative default path does not exist.
      '-ReleaseDir',
      'C:\\app\\resources\\native-camera',
    ]);
    assert.equal(call.options.windowsHide, true);
  }
});

test('remove unregisters the DirectShow filter', async () => {
  const { installer, calls } = harness();
  await installer.remove();
  assert.equal(
    calls[0].args[5],
    'C:\\app\\resources\\native-camera\\register-dshow-camera.ps1',
  );
  assert.deepEqual(calls[0].args.slice(6), ['-Action', 'Remove']);
});

test('install and repair are the same idempotent registration', async () => {
  // Re-registering is the correct response to a moved file, an app update, or a
  // half-removed earlier install, so the UI can offer it at any time.
  const { installer, calls } = harness();
  await installer.install();
  await installer.repair();
  assert.deepEqual(calls[0].args, calls[1].args);
});

test('install requires the DirectShow filter and nothing from the retired MF path', async () => {
  // The guard used to demand vcam-host.exe and twinscript-vcam-source.dll, which
  // the shipping camera does not use. A resources directory carrying only the
  // DirectShow filter is complete and must install.
  const present = new Set([
    'C:\\app\\resources\\native-camera\\register-dshow-camera.ps1',
    'C:\\app\\resources\\native-camera\\twinscript-dshow-camera.dll',
  ]);
  const { installer, calls } = harness({ existsSync: (p) => present.has(p) });
  await installer.install();
  assert.equal(calls.length, 1);
});

test('install refuses when the filter itself is missing', async () => {
  const { installer, calls } = harness({
    existsSync: (p) => p.endsWith('register-dshow-camera.ps1'),
  });
  await assert.rejects(() => installer.install(), /twinscript-dshow-camera\.dll/);
  assert.equal(calls.length, 0);
});

test('remove does not require the filter to still be on disk', async () => {
  // The registered path is read from the registry, so unregistering must work even
  // after the DLL is gone - otherwise a partial uninstall is unrecoverable.
  const { installer, calls } = harness({
    existsSync: (p) => p.endsWith('register-dshow-camera.ps1'),
  });
  await installer.remove();
  assert.equal(calls.length, 1);
});

test('unsupported systems never request elevation', async () => {
  const { installer, calls } = harness({ supported: false });
  await assert.rejects(() => installer.install(), /Windows 11 x64/i);
  assert.equal(calls.length, 0);
});

test('UAC cancellation is reported without retrying elevation', async () => {
  const { installer, calls } = harness({ exitCode: 1223 });
  await assert.rejects(() => installer.install(), /cancel/i);
  assert.equal(calls.length, 1);
});

