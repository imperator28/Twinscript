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
const STARTUP_CANCELLED = Symbol('startup-cancelled');
const PROCESS_CLOSED = Symbol('process-closed');

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
    const selectedDeviceId = `CUDA${BigInt(selectedDevice.slice(4))}`;
    return freezeRuntimeDescriptor({
      family,
      runtime,
      requestedDevice,
      launchArgs: ['--device', selectedDeviceId, '--gpu-layers', 'auto', '--fit', 'on'],
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
    this.startupAttempt = null;
    this.stopPromise = null;
    this.cleanupPromises = new WeakMap();
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
      const deviceId = `CUDA${BigInt(deviceMatch[1])}`;
      const deviceName = deviceMatch[2].trim().slice(0, 160);
      const previous = this.runtimeEvidence.devices.get(deviceId);
      if (deviceId === this.selectedCudaDevice &&
          (!previous || (!NVIDIA_DEVICE_PATTERN.test(previous) && NVIDIA_DEVICE_PATTERN.test(deviceName)))) {
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

  createStartupAttempt() {
    const controller = new AbortController();
    let resolveCancellation;
    const cancellation = new Promise((resolve) => { resolveCancellation = resolve; });
    return {
      cancelled: false,
      cancellation,
      controller,
      cancel() {
        if (this.cancelled) return;
        this.cancelled = true;
        resolveCancellation(STARTUP_CANCELLED);
        controller.abort();
      },
    };
  }

  startupCancelledError() {
    return llamaError('local_translation_start_cancelled', 'Local Hy-MT2 startup was cancelled');
  }

  hostClosedError(child, processState) {
    const code = processState.code ?? child?.exitCode;
    const signal = processState.signal ?? child?.signalCode;
    const status = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
    const stderr = processState.stderr || this.stderr.slice(-2_000);
    return llamaError(
      'local_translation_host_closed',
      `llama.cpp exited with ${status}: ${stderr}`,
    );
  }

  async awaitStartup(work, attempt, processState = null) {
    const races = [Promise.resolve(work), attempt.cancellation];
    if (processState) races.push(processState.closedPromise);
    const result = await Promise.race(races);
    if (result === STARTUP_CANCELLED) throw this.startupCancelledError();
    if (result === PROCESS_CLOSED) throw this.hostClosedError(processState.child, processState);
    return result;
  }

  async awaitStartupDelay(delayMs, attempt, processState) {
    let timer;
    try {
      await this.awaitStartup(
        new Promise((resolve) => { timer = setTimeout(resolve, delayMs); }),
        attempt,
        processState,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  assertProcessOpen(child, processState) {
    if (processState.closed || child.exitCode != null || child.signalCode) {
      if (!processState.stderr) processState.stderr = this.stderr.slice(-2_000);
      throw this.hostClosedError(child, processState);
    }
  }

  clearProcessState(child = null) {
    if (child && this.child && this.child !== child) return;
    this.child = null;
    this.started = false;
    this.port = 0;
    this.loadMs = 0;
    this.resetEvidence();
  }

  async cleanupProcess(child, { alreadyClosed = false } = {}) {
    this.detachProcessListeners(child);
    this.clearProcessState(child);
    if (!child || alreadyClosed || child.exitCode != null || child.signalCode) return;
    const existing = this.cleanupPromises.get(child);
    if (existing) return existing;

    const cleanup = (async () => {
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
      if (!closed && child.exitCode == null && !child.signalCode) {
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
      if (!closed && child.exitCode == null && !child.signalCode) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Public state is already clear; cleanup remains bounded.
        }
      }
      child.removeListener?.('close', onClose);
    })();
    this.cleanupPromises.set(child, cleanup);
    try {
      await cleanup;
    } finally {
      this.cleanupPromises.delete(child);
    }
  }

  async start() {
    if (this.stopPromise) await this.stopPromise;
    if (this.started) return this.health();
    if (this.startPromise) return this.startPromise;
    if (this.restartCount > this.maxRestarts) {
      throw llamaError(
        'local_translation_restart_exhausted',
        'Local Hy-MT2 server already restarted once after an unexpected exit',
      );
    }
    const attempt = this.createStartupAttempt();
    this.startupAttempt = attempt;
    const startPromise = this.startProcess(attempt);
    this.startPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
      if (this.startupAttempt === attempt) this.startupAttempt = null;
    }
  }

  async startProcess(attempt) {
    const startedAt = performance.now();
    this.resetEvidence();
    let child = null;
    let processState = null;
    try {
      this.port = await this.awaitStartup(this.allocatePort(), attempt);
      if (attempt.cancelled) throw this.startupCancelledError();
      const args = [
        '-m', this.modelPath,
        '--host', '127.0.0.1',
        '--port', String(this.port),
        '--no-webui', '-c', '2048',
        '--log-colors', 'off',
        ...this.runtimeDescriptor.launchArgs,
      ];
      try {
        child = this.spawnImpl(this.binaryPath, args, {
          cwd: path.dirname(this.binaryPath),
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (error) {
        throw llamaError('local_translation_spawn_failed', error.message);
      }
      this.child = child;
      let spawnError = null;
      let resolveClosed;
      processState = {
        child,
        closed: false,
        code: null,
        signal: null,
        stderr: '',
        closedPromise: new Promise((resolve) => { resolveClosed = resolve; }),
      };
      const onError = (error) => { spawnError = error; };
      const onClose = (code, signal) => {
        processState.closed = true;
        processState.code = code;
        processState.signal = signal;
        processState.stderr = this.stderr.slice(-2_000);
        resolveClosed(PROCESS_CLOSED);
        if (this.child !== child) return;
        const wasStarted = this.started;
        if (wasStarted) this.restartCount += 1;
        this.detachProcessListeners(child);
        this.clearProcessState(child);
      };
      const onStderr = (chunk) => this.recordStderr(chunk);
      this.processListeners = { child, onError, onClose, onStderr };
      child.once?.('error', onError);
      child.once?.('close', onClose);
      child.stderr?.on('data', onStderr);

      const deadline = Date.now() + this.startupTimeoutMs;
      while (Date.now() < deadline) {
        if (spawnError) {
          throw llamaError('local_translation_spawn_failed', spawnError.message);
        }
        this.assertProcessOpen(child, processState);
        try {
          const timeoutSignal = AbortSignal.timeout(2_000);
          const signal = typeof AbortSignal.any === 'function'
            ? AbortSignal.any([timeoutSignal, attempt.controller.signal])
            : timeoutSignal;
          const response = await this.awaitStartup(
            this.fetchImpl(`http://127.0.0.1:${this.port}/health`, { signal }),
            attempt,
            processState,
          );
          if (spawnError) {
            throw llamaError('local_translation_spawn_failed', spawnError.message);
          }
          this.assertProcessOpen(child, processState);
          if (response.ok) {
            const provenance = this.runtimeProvenance();
            if (this.runtimeDescriptor.family === 'cuda' &&
                (provenance.actualDevice !== this.selectedCudaDevice ||
                 !NVIDIA_DEVICE_PATTERN.test(provenance.deviceName || ''))) {
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
          if (error.code === 'local_translation_start_cancelled' ||
              error.code === 'local_translation_spawn_failed' ||
              error.code === 'local_translation_health_failed' ||
              error.code === 'local_translation_device_unverified' ||
              error.code === 'local_translation_host_closed') throw error;
        }
        await this.awaitStartupDelay(200, attempt, processState);
      }
      throw llamaError(
        'local_translation_start_timeout',
        `llama.cpp did not become ready: ${this.stderr.slice(-2_000)}`,
      );
    } catch (error) {
      await this.cleanupProcess(child, { alreadyClosed: processState?.closed });
      throw error;
    }
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

  async performStop() {
    const pendingStart = this.startPromise;
    this.startupAttempt?.cancel();
    await this.cleanupProcess(this.child);
    if (pendingStart) await pendingStart.catch(() => {});
    this.clearProcessState();
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    let stopPromise;
    stopPromise = Promise.resolve()
      .then(() => this.performStop())
      .finally(() => {
        if (this.stopPromise === stopPromise) this.stopPromise = null;
      });
    this.stopPromise = stopPromise;
    return stopPromise;
  }
}

module.exports = {
  CPU_RUNTIME,
  CUDA_RUNTIME,
  LlamaTranslationServer,
  allocateLoopbackPort,
};
