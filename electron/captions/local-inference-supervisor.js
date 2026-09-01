const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { LocalInferenceClient } = require('./local-inference-client');
const { HybridLocalInferenceClient } = require('./hybrid-local-inference-client');
const {
  CPU_RUNTIME,
  CUDA_RUNTIME,
  LlamaTranslationServer,
} = require('./llama-translation-client');
const { LlamaCudaProbe } = require('./llama-runtime-probe');
const { HyMt2RuntimeController } = require('./hy-mt2-runtime-controller');

function supervisorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolveLocalInferenceExecutable({ isPackaged, resourcesPath, appPath }) {
  const root = isPackaged
    ? path.win32.join(resourcesPath, 'local-inference-host')
    : path.win32.join(appPath, 'artifacts', 'local-inference-host');
  return path.win32.join(root, 'twinscript-local-inference.exe');
}

const REQUIRED_WHISPER_FILES = [
  'openvino_encoder_model.xml',
  'openvino_encoder_model.bin',
  'openvino_decoder_model.xml',
  'openvino_decoder_model.bin',
  'openvino_tokenizer.xml',
  'openvino_tokenizer.bin',
  'openvino_detokenizer.xml',
  'openvino_detokenizer.bin',
];

function hasVerifiedMarker(modelPath, requiredFiles, fsImpl = fs) {
  try {
    const directory = fsImpl.statSync(modelPath).isDirectory()
      ? modelPath
      : path.dirname(modelPath);
    const marker = JSON.parse(fsImpl.readFileSync(path.join(directory, '.verified.json'), 'utf8'));
    if (marker.version !== path.basename(directory) ||
        !marker.files || typeof marker.files !== 'object') return false;
    return requiredFiles.every((relativePath) => {
      const digest = marker.files[relativePath];
      const filePath = path.join(directory, ...relativePath.split('/'));
      return /^[a-f0-9]{64}$/i.test(digest || '') && fsImpl.statSync(filePath).size > 0;
    });
  } catch {
    return false;
  }
}

function hasDevelopmentModel(modelPath, requiredFiles, fsImpl = fs) {
  try {
    const directory = fsImpl.statSync(modelPath).isDirectory()
      ? modelPath
      : path.dirname(modelPath);
    return requiredFiles.every((relativePath) =>
      fsImpl.statSync(path.join(directory, ...relativePath.split('/'))).size > 0,
    );
  } catch {
    return false;
  }
}

function verifyRuntimeManifest(executablePath, fsImpl = fs) {
  try {
    const root = path.dirname(executablePath);
    const manifest = JSON.parse(fsImpl.readFileSync(path.join(root, 'runtime-manifest.json'), 'utf8'));
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) return false;
    let containsHost = false;
    for (const entry of manifest.files) {
      if (!entry || typeof entry.path !== 'string' || !Number.isSafeInteger(entry.size)) return false;
      if (!/^[a-f0-9]{64}$/i.test(entry.sha256 || '')) return false;
      const candidate = path.resolve(root, ...entry.path.split('/'));
      const relative = path.relative(root, candidate);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
      if (fsImpl.statSync(candidate).size !== entry.size) return false;
      const digest = crypto.createHash('sha256').update(fsImpl.readFileSync(candidate)).digest('hex');
      if (digest.toLowerCase() !== entry.sha256.toLowerCase()) return false;
      if (path.resolve(candidate) === path.resolve(executablePath)) containsHost = true;
    }
    return containsHost;
  } catch {
    return false;
  }
}

class LocalInferenceSupervisor extends EventEmitter {
  constructor({
    spawn = childProcess.spawn,
    isPackaged = false,
    resourcesPath = process.resourcesPath || '',
    appPath = process.cwd(),
    executablePath,
    whisperModelPath = null,
    whisperDevice = 'NPU',
    cachePath = null,
    llamaCpuBinaryPath = null,
    llamaCudaBinaryPath = null,
    hyMt2ModelPath = null,
    cudaEnabled = false,
    translationRuntime = null,
    exists = fs.existsSync,
    artifactReady = null,
    modelReady = null,
  } = {}) {
    super();
    this.spawnImpl = spawn;
    this.isPackaged = isPackaged;
    this.executablePath = executablePath || resolveLocalInferenceExecutable({
      isPackaged,
      resourcesPath,
      appPath,
    });
    this.generation = 0;
    this.restartCount = 0;
    this.whisperModelPath = whisperModelPath;
    this.whisperDevice = whisperDevice;
    this.cachePath = cachePath;
    this.llamaCpuBinaryPath = llamaCpuBinaryPath;
    this.llamaCudaBinaryPath = llamaCudaBinaryPath;
    this.hyMt2ModelPath = hyMt2ModelPath;
    this.cudaEnabled = cudaEnabled === true;
    this.exists = exists;
    this.artifactReady = artifactReady;
    this.modelReady = modelReady;
    this.runtimeIntegrity = null;
    this.lastModels = new Map();
    if (translationRuntime) {
      this.translationRuntime = translationRuntime;
    } else if (llamaCpuBinaryPath && hyMt2ModelPath) {
      const cpuServer = new LlamaTranslationServer({
        binaryPath: llamaCpuBinaryPath,
        modelPath: hyMt2ModelPath,
        runtimeDescriptor: CPU_RUNTIME,
      });
      const cudaServer = llamaCudaBinaryPath
        ? new LlamaTranslationServer({
            binaryPath: llamaCudaBinaryPath,
            modelPath: hyMt2ModelPath,
            runtimeDescriptor: CUDA_RUNTIME,
            maxRestarts: 0,
          })
        : null;
      this.translationRuntime = new HyMt2RuntimeController({
        enabled: this.cudaEnabled,
        probe: cudaServer ? new LlamaCudaProbe({ binaryPath: llamaCudaBinaryPath }) : null,
        cudaServer,
        cpuServer,
      });
    } else {
      this.translationRuntime = null;
    }
    this.onTranslationStatus = (model) => {
      if (!model || model.id !== 'hy-mt2-1.8b') return;
      this.lastModels.set(model.id, model);
      this.emit('model-status', model);
    };
    this.translationRuntime?.on?.('status', this.onTranslationStatus);
    this.requestedModels = [];
    this.lastSessionId = 'local-host';
    this.child = null;
    this.baseClient = null;
    this.activeClient = null;
    this.transport = null;
    this.expectedCloseGenerations = new Set();
    this.restartPromise = null;
    this.shuttingDown = false;
  }

  accept(message) {
    if (message?.generation !== this.generation) return false;
    this.emit('message', message);
    return true;
  }

  createTransport(child, processGeneration = this.generation) {
    const transport = new EventEmitter();
    transport.write = (line) => new Promise((resolve, reject) => {
      if (child.stdin.destroyed || child.stdin.writableEnded) {
        reject(supervisorError('local_host_pipe_closed', 'Local inference input pipe is closed'));
        return;
      }
      child.stdin.write(line, (error) => error ? reject(error) : resolve());
    });
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const message = { ...JSON.parse(line), generation: processGeneration };
          if (this.accept(message)) transport.emit('message', message);
        } catch (error) {
          this.emit('diagnostic', { code: 'local_host_invalid_json', message: error.message });
        }
      }
    });
    child.once('close', () => {
      transport.emit('close');
      this.handleHostClose(processGeneration);
    });
    child.stderr.on('data', (chunk) => this.emit('diagnostic', {
      code: 'local_host_stderr',
      message: chunk.toString('utf8').slice(-2000),
    }));
    return transport;
  }

  handleHostClose(processGeneration) {
    if (processGeneration !== this.generation) return;
    if (this.expectedCloseGenerations.delete(processGeneration)) return;
    if (this.shuttingDown || this.requestedModels.length === 0 || this.restartPromise) return;
    this.emit('diagnostic', {
      code: 'local_host_closed_unexpectedly',
      message: 'Local inference host closed unexpectedly; attempting one restart',
    });
    this.restartPromise = Promise.resolve()
      .then(() => this.restart())
      .catch((error) => this.emit('diagnostic', {
        code: error.code || 'local_host_restart_failed',
        message: error.message,
      }))
      .finally(() => {
        this.restartPromise = null;
      });
  }

  hostArguments(models = this.requestedModels) {
    if (!models.includes('whisper-small')) return [];
    if (!this.whisperModelPath) {
      throw supervisorError(
        'local_model_missing',
        'Local Whisper is selected but its verified model path is unavailable',
      );
    }
    const args = [
      '--whisper-model', this.whisperModelPath,
      '--whisper-device', this.whisperDevice,
    ];
    if (this.cachePath) args.push('--cache-dir', this.cachePath);
    return args;
  }

  readiness() {
    const actual = (model) => this.lastModels.get(model)?.actualDevice || null;
    let translationHealth = null;
    try {
      translationHealth = this.translationRuntime?.health?.() || null;
    } catch {
      translationHealth = null;
    }
    if (this.runtimeIntegrity == null) {
      this.runtimeIntegrity = this.artifactReady
        ? this.artifactReady('runtime', this.executablePath)
        : verifyRuntimeManifest(this.executablePath);
    }
    const whisperReady = this.isPackaged
      ? Boolean(this.modelReady?.('whisper-small'))
      : this.artifactReady
      ? this.artifactReady('whisper-small', this.whisperModelPath)
      : Boolean(this.whisperModelPath && (
          this.isPackaged
            ? hasVerifiedMarker(this.whisperModelPath, REQUIRED_WHISPER_FILES)
            : hasDevelopmentModel(this.whisperModelPath, REQUIRED_WHISPER_FILES)
        ));
    const hyMt2File = this.hyMt2ModelPath ? path.basename(this.hyMt2ModelPath) : '';
    const hyMt2Ready = Boolean(
      this.llamaCpuBinaryPath && this.exists(this.llamaCpuBinaryPath) &&
      (this.isPackaged
        ? this.modelReady?.('hy-mt2-1.8b')
        : this.artifactReady
          ? this.artifactReady('hy-mt2-1.8b', this.hyMt2ModelPath)
          : this.hyMt2ModelPath && hasDevelopmentModel(this.hyMt2ModelPath, [hyMt2File])
      ),
    );
    return {
      runtimeReady: Boolean(this.runtimeIntegrity),
      requestedDevice: this.whisperDevice,
      models: {
        'whisper-small': {
          ready: whisperReady,
          actualDevice: actual('whisper-small'),
        },
        'hy-mt2-1.8b': {
          ready: hyMt2Ready,
          actualDevice: translationHealth
            ? translationHealth.actualDevice || null
            : actual('hy-mt2-1.8b'),
        },
      },
    };
  }

  createHybridClient() {
    if (!this.baseClient) return null;
    return new HybridLocalInferenceClient({
      base: this.baseClient,
      translation: this.translationRuntime,
    });
  }

  async start(models = this.requestedModels) {
    if (this.baseClient && this.activeClient) return this.activeClient;
    const existingClient = this.activeClient;
    this.generation += 1;
    const processGeneration = this.generation;
    const child = this.spawnImpl(this.executablePath, this.hostArguments(models), {
      cwd: path.dirname(this.executablePath),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.transport = this.createTransport(child, processGeneration);
    const baseClient = new LocalInferenceClient({
      transport: this.transport,
      generation: processGeneration,
      timeoutMs: 30_000,
    });
    this.baseClient = baseClient;
    if (this.activeClient) {
      this.activeClient.replaceBase(baseClient);
    } else {
      this.activeClient = this.createHybridClient();
    }
    try {
      await baseClient.request('hello', { sessionId: 'local-host' }, { timeoutMs: 120_000 });
      return this.activeClient;
    } catch (error) {
      await this.disposeProcess({ preserveClient: Boolean(existingClient) });
      throw error;
    }
  }

  async probe() {
    const client = await this.start();
    return client.request('health', { sessionId: 'local-host' });
  }

  async prepare(models, sessionId = 'local-host') {
    this.requestedModels = [...models];
    if (sessionId !== this.lastSessionId) this.restartCount = 0;
    this.lastSessionId = sessionId;
    const readiness = this.readiness();
    if (!this.activeClient && !readiness.runtimeReady) {
      throw supervisorError('local_runtime_missing', 'The local inference runtime is not installed');
    }
    if (models.includes('whisper-small') && !readiness.models['whisper-small'].ready) {
      throw supervisorError('local_model_missing', 'The verified Whisper model is not installed');
    }
    if (
      models.includes('hy-mt2-1.8b') &&
      (this.llamaCpuBinaryPath || this.hyMt2ModelPath) &&
      !readiness.models['hy-mt2-1.8b'].ready
    ) {
      throw supervisorError('local_model_missing', 'The verified Hy-MT2 model is not installed');
    }
    await this.start(models);
    const wantsTranslation = models.includes('hy-mt2-1.8b');
    if (wantsTranslation) {
      if (!this.translationRuntime) {
        throw supervisorError(
          'local_model_missing',
          'Local Hy-MT2 is selected but its verified runtime is unavailable',
        );
      }
      await this.translationRuntime.beginSession?.(sessionId);
      await this.translationRuntime.start();
    }
    const nativeModels = models.filter((model) => model === 'whisper-small');
    const response = await this.baseClient.request(
      'model.prepare',
      { sessionId, models: nativeModels },
      { timeoutMs: 120_000 },
    );
    if (wantsTranslation) {
      response.models = [
        ...(Array.isArray(response.models) ? response.models : []),
        this.translationRuntime.health(),
      ];
    }
    for (const model of response.models || []) {
      if (model?.id) this.lastModels.set(model.id, model);
    }
    return response;
  }

  client() {
    if (!this.activeClient) {
      throw supervisorError('local_host_not_ready', 'Local inference host is not ready');
    }
    return this.activeClient;
  }

  async restart() {
    if (this.restartCount >= 1) {
      throw supervisorError(
        'local_host_restart_exhausted',
        'Local inference host already restarted once in this session',
      );
    }
    this.restartCount += 1;
    await this.disposeProcess({ preserveClient: true, stopTranslation: false });
    await this.start(this.requestedModels);
    return this.prepare(this.requestedModels, this.lastSessionId);
  }

  async disposeProcess({ preserveClient = false, stopTranslation = true } = {}) {
    const client = this.baseClient;
    const child = this.child;
    const activeClient = this.activeClient;
    const processGeneration = this.generation;
    if (child) this.expectedCloseGenerations.add(processGeneration);
    if (preserveClient) {
      activeClient?.replaceBase(null);
    } else {
      this.activeClient = null;
    }
    this.baseClient = null;
    this.transport = null;
    this.child = null;
    if (child) {
      try {
        if (client && child.exitCode == null) {
          await client.request('shutdown', { sessionId: 'local-host' }, { timeoutMs: 2_000 });
        }
      } catch {
        // The bounded kill below is the fail-safe for an unresponsive host.
      } finally {
        client?.dispose();
      }
      if (child.exitCode == null) child.kill();
    }
    if (!preserveClient) activeClient?.dispose({ disposeBase: false });
    if (stopTranslation) await this.translationRuntime?.stop();
  }

  async dispose() {
    this.shuttingDown = true;
    try {
      await this.disposeProcess();
    } finally {
      this.translationRuntime?.off?.('status', this.onTranslationStatus);
      this.removeAllListeners();
    }
  }
}

module.exports = {
  LocalInferenceSupervisor,
  hasVerifiedMarker,
  resolveLocalInferenceExecutable,
  verifyRuntimeManifest,
};
