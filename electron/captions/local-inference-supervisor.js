const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { LocalInferenceClient } = require('./local-inference-client');
const { HybridLocalInferenceClient } = require('./hybrid-local-inference-client');
const { LlamaTranslationServer } = require('./llama-translation-client');

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
    llamaBinaryPath = null,
    hyMt2ModelPath = null,
    translationServer = null,
    exists = fs.existsSync,
  } = {}) {
    super();
    this.spawnImpl = spawn;
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
    this.llamaBinaryPath = llamaBinaryPath;
    this.hyMt2ModelPath = hyMt2ModelPath;
    this.exists = exists;
    this.lastModels = new Map();
    this.translationServer = translationServer || (
      llamaBinaryPath && hyMt2ModelPath
        ? new LlamaTranslationServer({
            binaryPath: llamaBinaryPath,
            modelPath: hyMt2ModelPath,
          })
        : null
    );
    this.requestedModels = [];
    this.child = null;
    this.baseClient = null;
    this.activeClient = null;
    this.transport = null;
  }

  accept(message) {
    if (message?.generation !== this.generation) return false;
    this.emit('message', message);
    return true;
  }

  createTransport(child, processGeneration = this.generation) {
    const transport = new EventEmitter();
    transport.write = (line) => child.stdin.write(line);
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
    child.once('close', () => transport.emit('close'));
    child.stderr.on('data', (chunk) => this.emit('diagnostic', {
      code: 'local_host_stderr',
      message: chunk.toString('utf8').slice(-2000),
    }));
    return transport;
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
    return {
      runtimeReady: this.exists(this.executablePath),
      requestedDevice: this.whisperDevice,
      models: {
        'whisper-small': {
          ready: Boolean(this.whisperModelPath && this.exists(this.whisperModelPath)),
          actualDevice: actual('whisper-small'),
        },
        'hy-mt2-1.8b': {
          ready: Boolean(
            this.llamaBinaryPath && this.exists(this.llamaBinaryPath) &&
            this.hyMt2ModelPath && this.exists(this.hyMt2ModelPath)
          ),
          actualDevice: actual('hy-mt2-1.8b'),
        },
      },
    };
  }

  createHybridClient() {
    if (!this.baseClient) return null;
    return new HybridLocalInferenceClient({
      base: this.baseClient,
      translation: this.translationServer,
    });
  }

  async start(models = this.requestedModels) {
    if (this.activeClient) return this.activeClient;
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
    this.activeClient = this.createHybridClient();
    try {
      await baseClient.request('hello', { sessionId: 'local-host' }, { timeoutMs: 120_000 });
      return this.activeClient;
    } catch (error) {
      await this.disposeProcess();
      throw error;
    }
  }

  async probe() {
    const client = await this.start();
    return client.request('health', { sessionId: 'local-host' });
  }

  async prepare(models, sessionId = 'local-host') {
    this.requestedModels = [...models];
    const readiness = this.readiness();
    if (!this.activeClient && !readiness.runtimeReady) {
      throw supervisorError('local_runtime_missing', 'The local inference runtime is not installed');
    }
    if (models.includes('whisper-small') && !readiness.models['whisper-small'].ready) {
      throw supervisorError('local_model_missing', 'The verified Whisper model is not installed');
    }
    if (
      models.includes('hy-mt2-1.8b') &&
      (this.llamaBinaryPath || this.hyMt2ModelPath) &&
      !readiness.models['hy-mt2-1.8b'].ready
    ) {
      throw supervisorError('local_model_missing', 'The verified Hy-MT2 model is not installed');
    }
    await this.start(models);
    const wantsTranslation = models.includes('hy-mt2-1.8b');
    if (wantsTranslation) {
      if (!this.translationServer) {
        throw supervisorError(
          'local_model_missing',
          'Local Hy-MT2 is selected but its verified runtime is unavailable',
        );
      }
      await this.translationServer.start();
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
        this.translationServer.health(),
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
    await this.disposeProcess();
    return this.start();
  }

  async disposeProcess() {
    const client = this.baseClient;
    const child = this.child;
    this.activeClient = null;
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
    await this.translationServer?.stop();
  }

  async dispose() {
    await this.disposeProcess();
    this.removeAllListeners();
  }
}

module.exports = {
  LocalInferenceSupervisor,
  resolveLocalInferenceExecutable,
};
