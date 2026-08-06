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

  // Install, repair and remove all act on the DirectShow filter, which is the
  // camera that ships. They previously drove install-native-camera.ps1, which
  // installs the Media Foundation source - a camera that enumerates everywhere and
  // renders a black feed in every meeting client. Repairing to a broken camera is
  // worse than offering no repair at all.
  //
  // Install and repair are the same operation: registering the filter is
  // idempotent, and re-registering is the correct response to a moved file, an app
  // update, or a half-removed earlier install.
  #register() {
    this.#assertSupported();
    return this.#run(
      'register-dshow-camera.ps1',
      [
        '-Action',
        'Install',
        // Explicit: in a packaged app the script sits beside the DLL in
        // resources/native-camera, where its dev-relative default cannot resolve.
        '-ReleaseDir',
        this.sourceDirectory,
      ],
      { requiresFilter: true },
    );
  }

  async install() {
    return this.#register();
  }

  async repair() {
    return this.#register();
  }

  async remove() {
    this.#assertSupported();
    return this.#run('register-dshow-camera.ps1', ['-Action', 'Remove']);
  }

  #run(scriptName, extraArgs = [], { requiresFilter = false } = {}) {
    const scriptPath = path.win32.join(this.scriptDirectory, scriptName);
    if (!this.existsSync(scriptPath)) {
      return Promise.reject(
        operationError(
          'native_camera_resources_missing',
          `Native camera resource is missing: ${scriptName}`,
        ),
      );
    }
    // Only the DirectShow filter is required, and only for install. This used to
    // demand vcam-host.exe and twinscript-vcam-source.dll - the Media Foundation
    // artifacts, which the shipping camera does not use. Gating install on files
    // no longer part of the product is how the UI came to refuse to install a
    // camera whose own DLL was present and fine.
    if (requiresFilter) {
      const filterPath = path.win32.join(
        this.sourceDirectory,
        'twinscript-dshow-camera.dll',
      );
      if (!this.existsSync(filterPath)) {
        return Promise.reject(
          operationError(
            'native_camera_resources_missing',
            'Native camera resource is missing: twinscript-dshow-camera.dll',
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
