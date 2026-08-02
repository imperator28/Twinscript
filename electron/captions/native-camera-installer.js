const fs = require('node:fs');
const path = require('node:path');
const { spawn: spawnChild, spawnSync } = require('node:child_process');

function operationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class NativeCameraInstaller {
  constructor({
    support,
    isPackaged = false,
    resourcesPath = process.resourcesPath,
    appPath = process.cwd(),
    spawn = spawnChild,
    existsSync = fs.existsSync,
    systemRoot = process.env.SystemRoot || 'C:\\Windows',
  } = {}) {
    this.support = support || { supported: false, reason: 'windows-only' };
    this.spawn = spawn;
    this.existsSync = existsSync;
    this.powershellPath = path.win32.join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    this.sourceDirectory = isPackaged
      ? path.win32.join(resourcesPath, 'native-camera')
      : path.resolve(appPath, 'native', 'camera-companion', 'build', 'Release');
    this.scriptDirectory = isPackaged
      ? path.win32.join(resourcesPath, 'native-camera')
      : path.resolve(appPath, 'scripts');
  }

  #assertSupported() {
    if (!this.support.supported) {
      throw operationError(
        'native_camera_unsupported',
        'The native camera requires Windows 11 x64. Use OBS Virtual Camera on this system.',
      );
    }
  }

  async install() {
    this.#assertSupported();
    return this.#run('install-native-camera.ps1', [
      '-SourceDirectory',
      this.sourceDirectory,
    ]);
  }

  async repair() {
    this.#assertSupported();
    return this.#run('install-native-camera.ps1', [
      '-SourceDirectory',
      this.sourceDirectory,
    ]);
  }

  async remove() {
    this.#assertSupported();
    return this.#run('uninstall-native-camera.ps1');
  }

  #run(scriptName, extraArgs = []) {
    const scriptPath = path.win32.join(this.scriptDirectory, scriptName);
    if (!this.existsSync(scriptPath)) {
      return Promise.reject(
        operationError(
          'native_camera_resources_missing',
          `Native camera resource is missing: ${scriptName}`,
        ),
      );
    }
    for (const sourceName of ['vcam-host.exe', 'bilingual-vcam-source.dll']) {
      if (
        extraArgs.length > 0 &&
        !this.existsSync(path.win32.join(this.sourceDirectory, sourceName))
      ) {
        return Promise.reject(
          operationError(
            'native_camera_resources_missing',
            `Native camera resource is missing: ${sourceName}`,
          ),
        );
      }
    }

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawn(
          this.powershellPath,
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            scriptPath,
            ...extraArgs,
          ],
          { windowsHide: true, stdio: 'ignore' },
        );
      } catch (error) {
        reject(error);
        return;
      }
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code === 0) {
          resolve({ completed: true });
          return;
        }
        if (code === 1223) {
          reject(
            operationError(
              'native_camera_approval_canceled',
              'Windows approval was canceled. The native camera was not changed.',
            ),
          );
          return;
        }
        reject(
          operationError(
            'native_camera_install_failed',
            `Native camera action failed (exit ${code ?? signal ?? 'unknown'}).`,
          ),
        );
      });
    });
  }
}

function runSquirrelNativeCameraCleanup({
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  existsSync = fs.existsSync,
  run = spawnSync,
  systemRoot = process.env.SystemRoot || 'C:\\Windows',
} = {}) {
  if (platform !== 'win32' || !resourcesPath) return false;
  const scriptPath = path.win32.join(
    resourcesPath,
    'native-camera',
    'uninstall-native-camera.ps1',
  );
  if (!existsSync(scriptPath)) return false;
  const powershellPath = path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const result = run(
    powershellPath,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  return result.status === 0;
}

module.exports = {
  NativeCameraInstaller,
  operationError,
  runSquirrelNativeCameraCleanup,
};
