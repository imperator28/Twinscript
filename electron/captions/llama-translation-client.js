const childProcess = require('child_process');
const net = require('net');
const path = require('path');


function freezeRuntimeDescriptor(descriptor) {
  return Object.freeze({
    family: descriptor.family,
    runtime: descriptor.runtime,
    requestedDevice: descriptor.requestedDevice,
    launchArgs: Object.freeze([...descriptor.launchArgs]),
  });
}

const CPU_RUNTIME = freezeRuntimeDescriptor({
  family: 'cpu',
  runtime: 'llama.cpp-b9940-cpu',
  requestedDevice: 'CPU',
  launchArgs: ['--gpu-layers', '0'],
});

const CUDA_RUNTIME = freezeRuntimeDescriptor({
  family: 'cuda',
  runtime: 'llama.cpp-b9940-cuda12.4',
  requestedDevice: 'CUDA_AUTO',
  launchArgs: ['--device', 'CUDA0', '--gpu-layers', 'auto', '--fit', 'on'],
});

const NVIDIA_DEVICE_PATTERN = /\bNVIDIA\b/i;

function runtimeArgumentValue(launchArgs, flag) {
  const index = launchArgs.indexOf(flag);
  return index >= 0 ? launchArgs[index + 1] : undefined;
}

function runtimeDescriptorError(message) {
  const error = new TypeError(message);
  error.code = 'local_translation_runtime_invalid';
  return error;
}

function validateRuntimeDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') {
    throw runtimeDescriptorError('runtimeDescriptor must be an object');
  }
  const { family, runtime, requestedDevice, launchArgs } = descriptor;
  if (family === 'cpu') {
    if (runtime !== CPU_RUNTIME.runtime ||
        requestedDevice !== CPU_RUNTIME.requestedDevice ||
        !Array.isArray(launchArgs) ||
        launchArgs.length !== CPU_RUNTIME.launchArgs.length ||
        launchArgs.some((arg, index) => arg !== CPU_RUNTIME.launchArgs[index])) {
      throw runtimeDescriptorError('CPU runtimeDescriptor must match the pinned CPU runtime');
    }
    return freezeRuntimeDescriptor(CPU_RUNTIME);
  }
  if (family === 'cuda') {
    const selectedDevice = Array.isArray(launchArgs) ? launchArgs[1] : null;
    if (runtime !== CUDA_RUNTIME.runtime ||
        requestedDevice !== CUDA_RUNTIME.requestedDevice ||
        !Array.isArray(launchArgs) ||
        launchArgs.length !== CUDA_RUNTIME.launchArgs.length ||
        launchArgs[0] !== '--device' ||
        !/^CUDA\d+$/i.test(selectedDevice || '') ||
        launchArgs[2] !== '--gpu-layers' ||
        launchArgs[3] !== 'auto' ||
        launchArgs[4] !== '--fit' ||
        launchArgs[5] !== 'on') {
      throw runtimeDescriptorError('CUDA runtimeDescriptor must match the pinned CUDA runtime');
    }
    return freezeRuntimeDescriptor({
      family,
      runtime,
      requestedDevice,
      launchArgs: ['--device', selectedDevice.toUpperCase(), '--gpu-layers', 'auto', '--fit', 'on'],
    });
  }
  throw runtimeDescriptorError('runtimeDescriptor.family must be cpu or cuda');
}


function llamaError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

class LlamaTranslationServer {
  constructor({
    binaryPath,
    modelPath,
    spawn = childProcess.spawn,
    fetchImpl = globalThis.fetch,
    allocatePort = allocateLoopbackPort,
    startupTimeoutMs = 120_000,
    requestTimeoutMs = 30_000,
    maxRestarts = 1,
    shutdownTimeoutMs = 2_000,
    runtimeDescriptor = CPU_RUNTIME,
  }) {
    this.binaryPath = binaryPath;
    this.modelPath = modelPath;
    this.spawnImpl = spawn;
    this.fetchImpl = fetchImpl;
    this.allocatePort = allocatePort;
    this.startupTimeoutMs = startupTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxRestarts = maxRestarts;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.runtimeDescriptor = validateRuntimeDescriptor(runtimeDescriptor);
    this.selectedCudaDevice = this.runtimeDescriptor.family === 'cuda'
      ? runtimeArgumentValue(this.runtimeDescriptor.launchArgs, '--device')
      : null;
    this.restartCount = 0;
    this.child = null;
    this.port = 0;
    this.started = false;
    this.startPromise = null;
    this.stderr = '';
    this.loadMs = 0;
    this.processListeners = null;
    this.resetEvidence();
  }

  resetEvidence() {
    this.stderr = '';
    this.stderrRemainder = '';
    this.runtimeEvidence = {
      devices: new Map(),
      offload: this.runtimeDescriptor.family === 'cpu' ? 'none' : 'unknown',
    };
  }

  recordStderr(chunk) {
    const text = chunk.toString('utf8');
    this.stderr = `${this.stderr}${text}`.slice(-8_000);
    const lines = `${this.stderrRemainder}${text}`.split(/\r?\n/);
    this.stderrRemainder = lines.pop().slice(-512);
    for (const line of lines) this.recordEvidenceLine(line);
  }

  recordEvidenceLine(line) {
    const deviceMatch = line.match(/(?:\bDevice\s+|\bCUDA)(\d+)\s*:\s*(.+?)\s*$/i);
    if (deviceMatch) {
      const deviceId = `CUDA${Number(deviceMatch[1])}`;
      const deviceName = deviceMatch[2].trim().slice(0, 160);
      const previous = this.runtimeEvidence.devices.get(deviceId);
      if (!previous || (!NVIDIA_DEVICE_PATTERN.test(previous) && NVIDIA_DEVICE_PATTERN.test(deviceName))) {
        this.runtimeEvidence.devices.set(deviceId, deviceName);
      }
    }
    const offloadMatch = line.match(/offloaded\s+(\d+)\s*\/\s*(\d+)\s+layers\s+to\s+GPU/i);
    if (!offloadMatch) return;
    const offloaded = Number(offloadMatch[1]);
    const total = Number(offloadMatch[2]);
    let observed = 'unknown';
    if (Number.isFinite(offloaded) && Number.isFinite(total) && total > 0) {
      if (offloaded === total) observed = 'full';
      else if (offloaded > 0 && offloaded < total) observed = 'partial';
      else if (offloaded === 0) observed = 'none';
    }
    const strength = { unknown: 0, none: 1, partial: 2, full: 3 };
    if (strength[observed] > strength[this.runtimeEvidence.offload]) {
      this.runtimeEvidence.offload = observed;
    }
  }

  runtimeProvenance() {
    if (this.runtimeDescriptor.family === 'cpu') {
      return {
        runtime: this.runtimeDescriptor.runtime,
        requestedDevice: this.runtimeDescriptor.requestedDevice,
        actualDevice: 'CPU',
        deviceName: null,
        offload: 'none',
        fallbackReason: null,
      };
    }
    const deviceName = this.runtimeEvidence.devices.get(this.selectedCudaDevice) || null;
    return {
      runtime: this.runtimeDescriptor.runtime,
      requestedDevice: this.runtimeDescriptor.requestedDevice,
      actualDevice: deviceName && NVIDIA_DEVICE_PATTERN.test(deviceName) ? this.selectedCudaDevice : null,
      deviceName,
      offload: this.runtimeEvidence.offload,
      fallbackReason: null,
    };
  }

  detachProcessListeners(child) {
    const listeners = this.processListeners;
    if (!listeners || listeners.child !== child) return;
    child.removeListener?.('error', listeners.onError);
    child.removeListener?.('close', listeners.onClose);
    child.stderr?.removeListener?.('data', listeners.onStderr);
    this.processListeners = null;
  }

  async start() {
    if (this.started) return this.health();
    if (this.startPromise) return this.startPromise;
    if (this.restartCount > this.maxRestarts) {
      throw llamaError(
        'local_translation_restart_exhausted',
        'Local Hy-MT2 server already restarted once after an unexpected exit',
      );
    }
    this.startPromise = this.startProcess();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async startProcess() {
    const startedAt = performance.now();
    this.resetEvidence();
    this.port = await this.allocatePort();
    const args = [
      '-m', this.modelPath,
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '--no-webui', '-c', '2048',
      '--log-colors', 'off',
      ...this.runtimeDescriptor.launchArgs,
    ];
    let child;
    try {
      child = this.spawnImpl(this.binaryPath, args, {
        cwd: path.dirname(this.binaryPath),
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (error) {
      this.port = 0;
      throw llamaError('local_translation_spawn_failed', error.message);
    }
    this.child = child;
    let spawnError = null;
    const onError = (error) => { spawnError = error; };
    const onClose = () => {
      if (this.child !== child) return;
      const wasStarted = this.started;
      this.child = null;
      if (wasStarted) this.restartCount += 1;
      this.started = false;
      this.port = 0;
      this.detachProcessListeners(child);
      this.resetEvidence();
    };
    const onStderr = (chunk) => this.recordStderr(chunk);
    this.processListeners = { child, onError, onClose, onStderr };
    child.once?.('error', onError);
    child.once?.('close', onClose);
    child.stderr?.on('data', onStderr);
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (spawnError) {
        const message = spawnError.message;
        await this.stop();
        throw llamaError('local_translation_spawn_failed', message);
      }
      if (child.exitCode != null) {
        throw llamaError(
          'local_translation_host_closed',
          `llama.cpp exited with code ${child.exitCode}: ${this.stderr.slice(-2_000)}`,
        );
      }
      try {
        const response = await this.fetchImpl(
          `http://127.0.0.1:${this.port}/health`,
          { signal: AbortSignal.timeout(2_000) },
        );
        if (spawnError) {
          const message = spawnError.message;
          await this.stop();
          throw llamaError('local_translation_spawn_failed', message);
        }
        if (response.ok) {
          if (child.exitCode != null || this.child !== child) {
            throw llamaError(
              'local_translation_host_closed',
              'llama.cpp exited while reporting startup health',
            );
          }
          const provenance = this.runtimeProvenance();
          if (this.runtimeDescriptor.family === 'cuda' &&
              (provenance.actualDevice !== this.selectedCudaDevice ||
               !NVIDIA_DEVICE_PATTERN.test(provenance.deviceName || ''))) {
            await this.stop();
            throw llamaError(
              'local_translation_device_unverified',
              `llama.cpp did not prove NVIDIA execution on ${this.selectedCudaDevice}`,
            );
          }
          this.started = true;
          this.loadMs = performance.now() - startedAt;
          return this.health();
        }
        if (response.status !== 503) {
          throw llamaError('local_translation_health_failed', `llama.cpp health returned ${response.status}`);
        }
      } catch (error) {
        if (error.code === 'local_translation_spawn_failed' ||
            error.code === 'local_translation_health_failed' ||
            error.code === 'local_translation_device_unverified' ||
            error.code === 'local_translation_host_closed') throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const stderr = this.stderr;
    await this.stop();
    throw llamaError(
      'local_translation_start_timeout',
      `llama.cpp did not become ready: ${stderr.slice(-2_000)}`,
    );
  }

  health() {
    return {
      id: 'hy-mt2-1.8b',
      ...this.runtimeProvenance(),
      ready: this.started,
      loadMs: this.loadMs,
    };
  }

  async translate(type, payload, { signal } = {}) {
    if (!this.started) await this.start();
    let sourceText = String(payload.text || '');
    const protectedSpans = [];
    for (const token of payload.protectedTokens || []) {
      const literal = String(token || '').trim();
      if (!literal || !sourceText.includes(literal)) continue;
      const marker = `⟦TS${protectedSpans.length}⟧`;
      sourceText = sourceText.split(literal).join(marker);
      protectedSpans.push({ marker, literal });
    }
    const constraints = [];
    if (payload.glossary?.length) {
      constraints.push(
        `Use this terminology: ${payload.glossary.slice(0, 16).map((row) =>
          `${row.en || ''} = ${row.zh || ''}${row.doNotTranslate ? ' [keep verbatim]' : ''}`
        ).join('; ')}.`,
      );
    }
    const prompt =
      `Translate the following text into ${payload.targetLanguage}. ` +
      `${constraints.length ? `${constraints.join(' ')} ` : ''}` +
      'Note that you should only output the translated result without any additional explanation: ' +
      sourceText;
    const startedAt = performance.now();
    const requestController = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => requestController.abort(signal?.reason);
    if (signal?.aborted) requestController.abort(signal.reason);
    else signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      requestController.abort();
    }, this.requestTimeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await this.fetchImpl(
        `http://127.0.0.1:${this.port}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            max_tokens: 256,
          }),
          signal: requestController.signal,
        },
      );
    } catch (error) {
      if (timedOut) {
        throw llamaError('local_translation_timeout', 'Local Hy-MT2 translation timed out');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
    if (!response.ok) {
      throw llamaError('local_translation_failed', `llama.cpp returned HTTP ${response.status}`);
    }
    const body = await response.json();
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw llamaError('local_translation_invalid_result', 'llama.cpp returned no translation');
    }
    let translatedText = text.trim();
    for (const { marker, literal } of protectedSpans) {
      translatedText = translatedText.split(marker).join(literal);
    }
    return {
      protocolVersion: 1,
      type: 'translate.result',
      utteranceId: payload.utteranceId,
      sourceRevision: payload.sourceRevision,
      sourceLanguage: payload.sourceLanguage,
      text: translatedText,
      authoritative: type === 'translate.final',
      model: 'hy-mt2-1.8b-q4-k-m',
      ...this.runtimeProvenance(),
      inferenceMs: performance.now() - startedAt,
      inputTokens: Number(body.usage?.prompt_tokens || 0),
      completionTokens: Number(body.usage?.completion_tokens || 0),
    };
  }

  async stop() {
    const child = this.child;
    this.child = null;
    this.started = false;
    this.port = 0;
    this.loadMs = 0;
    this.detachProcessListeners(child);
    this.resetEvidence();
    if (!child || child.exitCode != null) return;

    let closed = false;
    let resolveClosed;
    const closedPromise = new Promise((resolve) => { resolveClosed = resolve; });
    const onClose = () => {
      closed = true;
      resolveClosed();
    };
    child.once?.('close', onClose);
    try {
      child.kill();
    } catch {
      // A failed normal kill still gets one bounded force attempt below.
    }
    if (!closed && child.exitCode == null) {
      let timer;
      await Promise.race([
        closedPromise,
        new Promise((resolve) => {
          timer = setTimeout(resolve, this.shutdownTimeoutMs);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    if (!closed && child.exitCode == null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // State and listeners are already cleared; stop remains bounded.
      }
    }
    child.removeListener?.('close', onClose);
  }
}

module.exports = {
  CPU_RUNTIME,
  CUDA_RUNTIME,
  LlamaTranslationServer,
  allocateLoopbackPort,
};
