const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { NativeCameraInstaller } = require('./native-camera-installer');

function harness({ supported = true, exitCode = 0 } = {}) {
  const calls = [];
  const installer = new NativeCameraInstaller({
    support: { supported, reason: supported ? null : 'windows-11-required' },
    isPackaged: true,
    resourcesPath: 'C:\\app\\resources',
    existsSync: () => true,
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
    assert.equal(
      call.args[5],
      'C:\\app\\resources\\native-camera\\install-native-camera.ps1',
    );
    assert.deepEqual(call.args.slice(6), [
      '-SourceDirectory',
      'C:\\app\\resources\\native-camera',
    ]);
    assert.equal(call.options.windowsHide, true);
  }
});

test('remove uses the dedicated unregister script and no source path', async () => {
  const { installer, calls } = harness();
  await installer.remove();
  assert.equal(
    calls[0].args.at(-1),
    'C:\\app\\resources\\native-camera\\uninstall-native-camera.ps1',
  );
  assert.equal(calls[0].args.includes('-SourceDirectory'), false);
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

