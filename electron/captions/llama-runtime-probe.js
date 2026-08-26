const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 16 * 1024;

function parseCudaDevices(output) {
  const matches = [...String(output || '').matchAll(/^\s*(CUDA\d+)\s*:\s*(.+?)\s*$/gim)];
  return matches
    .map(match => ({ actualDevice: match[1].toUpperCase(), deviceName: match[2].trim().slice(0, 160) }))
    .filter(device => /\bNVIDIA\b/i.test(device.deviceName));
}

class LlamaCudaProbe {
  constructor({ binaryPath, spawn, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.binaryPath = binaryPath;
    this.spawn = spawn;
    this.timeoutMs = timeoutMs;
    this.cacheGeneration = 0;
    this.completedResult = null;
    this.inFlight = null;
    this.activeProbe = null;
  }

  probe() {
    if (this.completedResult) {
      return Promise.resolve(this.completedResult);
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    const generation = this.cacheGeneration;
    let resolvePromise;
    const promise = new Promise(resolve => {
      resolvePromise = resolve;
    });
    this.inFlight = promise;

    let child = null;
    let timer = null;
    let settled = false;
    let outputBytes = 0;
    const outputParts = [];
    const lateErrorListener = () => {};

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (child) {
        child.stdout?.removeListener('data', onOutput);
        child.stderr?.removeListener('data', onOutput);
        child.removeListener('error', onError);
        child.removeListener('close', onClose);
      }
      if (this.activeProbe?.generation === generation) {
        this.activeProbe = null;
      }
    };

    const finish = fallbackReason => {
      if (settled) return;
      settled = true;
      cleanup();

      let result = unavailable(fallbackReason);
      if (!fallbackReason) {
        const device = selectLowestCudaDevice(parseCudaDevices(outputParts.join('')));
        result = device
          ? { usable: true, requestedDevice: 'CUDA_AUTO', actualDevice: device.actualDevice, deviceName: device.deviceName, fallbackReason: null }
          : unavailable('cuda_device_unavailable');
      }

      if (this.cacheGeneration === generation && this.inFlight === promise) {
        this.inFlight = null;
        this.completedResult = result;
      }
      resolvePromise(result);
    };

    const terminateAndFinish = fallbackReason => {
      try {
        child?.kill();
      } catch {
        // A failed cleanup kill does not change the capability failure result.
      }
      finish(fallbackReason);
    };

    const onOutput = chunk => {
      if (settled) return;
      const text = String(chunk);
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        terminateAndFinish('cuda_probe_output_overflow');
        return;
      }
      outputParts.push(text);
    };
    const onError = () => finish('cuda_probe_spawn_failed');
    const onClose = (code, signal) => {
      if (code !== 0 || signal) {
        finish('cuda_probe_exit_failed');
        return;
      }
      finish(null);
    };

    try {
      child = this.spawn(this.binaryPath, ['--list-devices'], {
        cwd: path.dirname(this.binaryPath),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (!child || typeof child.once !== 'function') {
        finish('cuda_probe_spawn_failed');
        return promise;
      }
      child.on('error', lateErrorListener);
      child.once('error', onError);
      child.once('close', onClose);
      child.stdout?.on('data', onOutput);
      child.stderr?.on('data', onOutput);
      this.activeProbe = { generation, child, finish };
      timer = setTimeout(() => terminateAndFinish('cuda_probe_timeout'), this.timeoutMs);
    } catch {
      finish('cuda_probe_spawn_failed');
    }

    return promise;
  }

  invalidate() {
    this.cacheGeneration += 1;
    this.completedResult = null;
    this.inFlight = null;
    const activeProbe = this.activeProbe;
    if (activeProbe) {
      try {
        activeProbe.child.kill();
      } catch {
        // Invalidation still settles the old generation if termination throws.
      }
      activeProbe.finish('cuda_probe_invalidated');
    }
  }
}

function selectLowestCudaDevice(devices) {
  return devices.reduce((lowest, device) => {
    if (!lowest) return device;
    return Number(device.actualDevice.slice(4)) < Number(lowest.actualDevice.slice(4)) ? device : lowest;
  }, null);
}

function unavailable(fallbackReason) {
  return {
    usable: false,
    requestedDevice: 'CUDA_AUTO',
    actualDevice: null,
    deviceName: null,
    fallbackReason,
  };
}

module.exports = { LlamaCudaProbe, parseCudaDevices };
