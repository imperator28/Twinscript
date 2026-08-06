const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn: spawnChild, spawnSync } = require('node:child_process');
const {
  describeDshowCamera,
  inspectDshowCamera,
} = require('./dshow-camera-registration.js');

const PRODUCT_DIRECTORY = 'Twinscript';

function windowsBuild(release) {
  const parts = String(release || '').split('.');
  const value = Number(parts.at(-1));
  return Number.isInteger(value) ? value : 0;
}

function nativeCameraSupport(
  platform = process.platform,
  release = os.release(),
  arch = process.arch,
) {
  const build = windowsBuild(release);
  if (platform !== 'win32') {
    return { supported: false, reason: 'windows-only', windowsBuild: build };
  }
  if (arch !== 'x64') {
    return { supported: false, reason: 'x64-required', windowsBuild: build };
  }
  if (build < 22000) {
    return {
      supported: false,
      reason: 'windows-11-required',
      windowsBuild: build,
    };
  }
  return { supported: true, reason: null, windowsBuild: build };
}

function defaultNativeCameraPaths(programData = process.env.ProgramData) {
  const root = programData || 'C:\\ProgramData';
  const installDirectory = path.win32.join(root, PRODUCT_DIRECTORY);
  const binaryDirectory = path.win32.join(installDirectory, 'bin');
  return {
    installDirectory,
    binaryDirectory,
    hostPath: path.win32.join(binaryDirectory, 'vcam-host.exe'),
    sourcePath: path.win32.join(binaryDirectory, 'twinscript-vcam-source.dll'),
    regionPath: path.win32.join(installDirectory, 'runtime', 'camera-frame-v1.bin'),
  };
}

function registeredMachineCamera({
  hostPath,
  sourcePath,
  expectedHostPath,
  expectedSourcePath,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  run = spawnSync,
}) {
  if (!existsSync(hostPath) || !existsSync(sourcePath)) return false;
  const result = run(hostPath, ['status-machine'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  if (result.status !== 0) return false;
  for (const [installed, expected] of [
    [hostPath, expectedHostPath],
    [sourcePath, expectedSourcePath],
  ]) {
    if (!expected) continue;
    try {
      const installedBytes = readFileSync(installed);
      const expectedBytes = readFileSync(expected);
      if (!installedBytes.equals(expectedBytes)) return 'repair-required';
    } catch {
      return 'repair-required';
    }
  }
  return true;
}

class NativeCameraSupervisor {
  constructor({
    platform = process.platform,
    release = os.release(),
    arch = process.arch,
    ...options
  } = {}) {
    const defaults = defaultNativeCameraPaths();
    this.support = nativeCameraSupport(platform, release, arch);
    this.hostPath = options.hostPath || defaults.hostPath;
    this.sourcePath = options.sourcePath || defaults.sourcePath;
    this.regionPath = options.regionPath || defaults.regionPath;
    this.expectedHostPath = options.expectedHostPath || null;
    this.expectedSourcePath = options.expectedSourcePath || null;
    this.spawn = options.spawn || spawnChild;
    this.createPipeServer = options.createPipeServer || ((listener) => net.createServer(listener));
    this.isInstalled = options.isInstalled || (() => registeredMachineCamera(this));
    // Injectable so health can be tested without a registry.
    this.inspectDshowCamera =
      options.inspectDshowCamera || (() => inspectDshowCamera({ platform }));
    this.randomId = options.randomId || randomUUID;
    this.restartDelayMs = options.restartDelayMs ?? 250;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 2000;
    this.onHealth = options.onHealth || (() => {});
    this.child = null;
    this.server = null;
    this.socket = null;
    this.lineBuffer = '';
    this.exitWaiters = new Set();
    this.stopRequested = false;
    this.restartCount = 0;
    this.health = {
      state: this.support.supported ? 'stopped' : 'unsupported',
      supported: this.support.supported,
      reason: this.support.reason,
      windowsBuild: this.support.windowsBuild,
      installed: false,
      restartCount: 0,
      message: null,
      code: null,
    };
  }

  snapshot() {
    return { ...this.health };
  }

  reportPublisherFailure(error) {
    return this.#publish({
      state: 'failed',
      message:
        error instanceof Error
          ? error.message
          : String(error || 'Camera frame publication failed'),
      code: error?.code || 'frame-publication-failed',
    });
  }

  #publish(patch) {
    this.health = {
      ...this.health,
      ...patch,
      restartCount: this.restartCount,
    };
    this.onHealth(this.snapshot());
    return this.snapshot();
  }

  async refresh() {
    if (!this.support.supported) {
      return this.#publish({
        state: 'unsupported',
        installed: false,
        reason: this.support.reason,
      });
    }
    // Health describes the DirectShow filter, which is the camera that ships and
    // the one a meeting client actually opens.
    //
    // It used to compare the installed Media Foundation host and media source
    // against the packaged copies and report "The installed camera does not match
    // this app version. Choose Repair camera." whenever those bytes moved. That was
    // wrong twice over: the MF camera is not the shipping camera, and Repair
    // installs the one that renders a black feed in every meeting client. Rebuilding
    // the app was enough to trigger it.
    const inspection = this.inspectDshowCamera();
    return this.#publish({
      state: inspection.installed ? 'installed' : 'not-installed',
      installed: inspection.installed,
      reason: inspection.reason,
      filterPath: inspection.filterPath,
      message: describeDshowCamera(inspection),
      code: inspection.reason,
    });
  }

  async start({ manual = false } = {}) {
    if (this.child) return this.snapshot();
    const status = await this.refresh();
    if (!status.supported || !status.installed || status.state === 'repair-required') {
      return status;
    }
    if (manual) this.restartCount = 0;
    this.stopRequested = false;
    return this.#launch();
  }

  #launch() {
    this.#closeTransport();
    const pipeName = `\\\\.\\pipe\\twinscript-camera-${this.randomId()}`;
    const server = this.createPipeServer((socket) => this.#acceptSocket(socket));
    this.server = server;
    server.on?.('error', (error) => {
      this.#publish({
        state: 'failed',
        message: `Camera health channel failed: ${error.message}`,
        code: error.code || null,
      });
    });
    server.listen(pipeName);

    this.#publish({ state: 'starting', message: null, code: null, installed: true });
    let child;
    try {
      child = this.spawn(
        this.hostPath,
        ['serve', '--region', this.regionPath, '--pipe', pipeName],
        { windowsHide: true, stdio: 'ignore' },
      );
    } catch (error) {
      this.#closeTransport();
      return this.#publish({
        state: 'failed',
        message: error.message,
        code: error.code || null,
      });
    }
    this.child = child;
    child.once?.('error', (error) => {
      if (this.child !== child || this.stopRequested) return;
      this.#handleExit(child, error.code || 1, null);
    });
    child.once?.('exit', (code, signal) => this.#handleExit(child, code, signal));
    return this.snapshot();
  }

  #acceptSocket(socket) {
    if (this.socket && this.socket !== socket) this.socket.destroy?.();
    this.socket = socket;
    this.lineBuffer = '';
    socket.on?.('data', (chunk) => this.#consumeHealth(chunk));
    socket.on?.('error', (error) => {
      if (!this.stopRequested) {
        this.#publish({
          state: 'failed',
          message: `Camera health channel disconnected: ${error.message}`,
          code: error.code || null,
        });
      }
    });
  }

  #consumeHealth(chunk) {
    this.lineBuffer += Buffer.from(chunk).toString('utf8');
    for (;;) {
      const newline = this.lineBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.lineBuffer.slice(0, newline).trim();
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        const health = JSON.parse(line);
        if (!['ready', 'streaming', 'failed', 'stopping'].includes(health.state)) {
          continue;
        }
        this.#publish({
          state: health.state,
          message: health.message || null,
          code: health.code ?? null,
        });
      } catch {
        this.#publish({
          state: 'failed',
          message: 'The camera companion sent invalid health data.',
          code: 'invalid-health-message',
        });
      }
    }
  }

  #handleExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    for (const resolve of this.exitWaiters) resolve();
    this.exitWaiters.clear();
    this.#closeTransport();
    if (this.stopRequested) {
      this.#publish({ state: 'stopped', message: null, code: null });
      return;
    }
    if (this.restartCount < 1) {
      this.restartCount += 1;
      this.#publish({
        state: 'restarting',
        message: 'The camera companion stopped unexpectedly. Restarting once.',
        code: code ?? signal ?? null,
      });
      const timer = setTimeout(() => {
        if (!this.stopRequested && !this.child) this.#launch();
      }, this.restartDelayMs);
      timer.unref?.();
      return;
    }
    this.#publish({
      state: 'failed',
      message: 'The camera stopped twice. Use Repair or retry manually; captions remain active.',
      code: code ?? signal ?? null,
    });
  }

  async stop() {
    this.stopRequested = true;
    if (!this.child) {
      this.#closeTransport();
      return this.#publish({ state: 'stopped', message: null, code: null });
    }
    this.#publish({ state: 'stopping', message: null, code: null });
    if (this.socket) {
      this.socket.write('{"command":"stop"}\n');
    } else {
      this.child.kill?.();
    }
    const child = this.child;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.exitWaiters.delete(finish);
        resolve();
      };
      this.exitWaiters.add(finish);
      const timer = setTimeout(() => {
        if (this.child === child) child.kill?.();
        finish();
      }, this.stopTimeoutMs);
      timer.unref?.();
    });
    if (this.child === child) {
      this.child = null;
      this.#closeTransport();
      this.#publish({ state: 'stopped', message: null, code: null });
    }
    return this.snapshot();
  }

  #closeTransport() {
    const socket = this.socket;
    this.socket = null;
    socket?.end?.();
    const server = this.server;
    this.server = null;
    server?.close?.();
    this.lineBuffer = '';
  }
}

module.exports = {
  NativeCameraSupervisor,
  defaultNativeCameraPaths,
  nativeCameraSupport,
  registeredMachineCamera,
  windowsBuild,
};
