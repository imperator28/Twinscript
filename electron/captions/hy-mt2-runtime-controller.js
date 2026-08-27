const { EventEmitter } = require('node:events');

const STATUS_FIELDS = Object.freeze([
  'id',
  'runtime',
  'ready',
  'requestedDevice',
  'actualDevice',
  'deviceName',
  'offload',
  'fallbackReason',
  'loadMs',
]);

const DEVICE_FAILURE_CODES = new Set([
  'local_translation_device_unverified',
  'local_translation_health_failed',
  'local_translation_host_closed',
  'local_translation_restart_exhausted',
  'local_translation_spawn_failed',
  'local_translation_start_timeout',
]);

const CONNECTION_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'UND_ERR_SOCKET',
]);

function abortError(message = 'Retired local translation request') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function cudaFailureReason(error, { startup = false } = {}) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (DEVICE_FAILURE_CODES.has(code)) return code;
  if (CONNECTION_FAILURE_CODES.has(code)) return 'local_translation_host_closed';
  return startup ? 'cuda_runtime_start_failed' : null;
}

function attachFallbackReason(error, fallbackReason) {
  if (!fallbackReason || !error || (typeof error !== 'object' && typeof error !== 'function')) {
    return error;
  }
  try {
    error.fallbackReason = fallbackReason;
  } catch {
    // Existing local errors are extensible; preserve their contract if a caller freezes one.
  }
  return error;
}

class HyMt2RuntimeController extends EventEmitter {
  constructor({ enabled = false, probe, cudaServer, cpuServer }) {
    super();
    this.enabled = enabled === true;
    this.probe = probe;
    this.cudaServer = cudaServer;
    this.cpuServer = cpuServer;

    this.sessionId = null;
    this.generation = 0;
    this.activeFamily = null;
    this.activeServer = null;
    this.fallbackReason = null;
    this.cudaRetired = false;
    this.fallbackPromise = null;

    this.lifecycleVersion = 0;
    this.startPromise = null;
    this.stopPromise = null;
    this.startingServer = null;
  }

  beginSession(sessionId) {
    if (this.sessionId === sessionId) {
      return this.stopPromise || Promise.resolve();
    }
    if (this.stopPromise) {
      this.lifecycleVersion += 1;
      this.generation += 1;
    }
    const stopping = this.stop();
    this.sessionId = sessionId;
    this.fallbackReason = null;
    this.cudaRetired = false;
    return stopping;
  }

  start() {
    const requestedLifecycle = this.lifecycleVersion;
    return this.startAfterStop(requestedLifecycle);
  }

  async startAfterStop(requestedLifecycle) {
    if (this.stopPromise) await this.stopPromise;
    this.assertLifecycle(requestedLifecycle);
    if (this.activeServer) return this.health();
    if (this.startPromise) return this.startPromise;

    const startPromise = this.selectRuntime(requestedLifecycle);
    this.startPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  async selectRuntime(lifecycle) {
    if (!this.enabled || this.cudaRetired) {
      return this.startCpu(lifecycle);
    }

    const probeResult = await this.probe.probe();
    this.assertLifecycle(lifecycle);
    if (!probeResult?.usable) {
      this.cudaRetired = true;
      this.fallbackReason = probeResult?.fallbackReason || 'cuda_device_unavailable';
      return this.startCpu(lifecycle);
    }

    this.startingServer = this.cudaServer;
    try {
      await this.cudaServer.start();
      if (lifecycle !== this.lifecycleVersion) {
        await this.cudaServer.stop();
        throw abortError('Local CUDA startup belonged to a retired session');
      }
      this.activeFamily = 'cuda';
      this.activeServer = this.cudaServer;
      this.emitStatus();
      return this.health();
    } catch (error) {
      if (lifecycle !== this.lifecycleVersion || error?.name === 'AbortError') {
        await this.cudaServer.stop();
        throw abortError('Local CUDA startup belonged to a retired session');
      }
      const reason = cudaFailureReason(error, { startup: true });
      this.retireCuda(reason);
      await this.cudaServer.stop();
      this.assertLifecycle(lifecycle);
      return this.startCpu(lifecycle);
    } finally {
      if (this.startingServer === this.cudaServer) this.startingServer = null;
    }
  }

  async startCpu(lifecycle) {
    this.startingServer = this.cpuServer;
    try {
      await this.cpuServer.start();
      if (lifecycle !== this.lifecycleVersion) {
        await this.cpuServer.stop();
        throw abortError('Local CPU startup belonged to a retired session');
      }
      this.activeFamily = 'cpu';
      this.activeServer = this.cpuServer;
      this.emitStatus();
      return this.health();
    } catch (error) {
      if (lifecycle !== this.lifecycleVersion || error?.name === 'AbortError') {
        await this.cpuServer.stop();
        throw abortError('Local CPU startup belonged to a retired session');
      }
      throw attachFallbackReason(error, this.fallbackReason);
    } finally {
      if (this.startingServer === this.cpuServer) this.startingServer = null;
    }
  }

  retireCuda(reason) {
    if (!this.cudaRetired) this.generation += 1;
    this.cudaRetired = true;
    this.fallbackReason = reason || 'cuda_runtime_failed';
    this.probe.invalidate();
  }

  health() {
    if (this.activeServer) return this.mergeProvenance(this.activeServer.health());
    return {
      id: 'hy-mt2-1.8b',
      runtime: null,
      ready: false,
      requestedDevice: this.enabled ? 'CUDA_AUTO' : 'CPU',
      actualDevice: null,
      deviceName: null,
      offload: 'unknown',
      fallbackReason: this.fallbackReason,
      loadMs: null,
    };
  }

  mergeProvenance(serverValue) {
    return {
      ...serverValue,
      requestedDevice: this.fallbackReason ? 'CUDA_AUTO' : serverValue.requestedDevice,
      fallbackReason: this.fallbackReason,
    };
  }

  emitStatus() {
    const health = this.health();
    const status = {};
    for (const field of STATUS_FIELDS) status[field] = health[field] ?? null;
    this.emit('status', status);
  }

  async translate(type, payload, options = {}) {
    if (!this.activeServer) await this.start();
    const requestGeneration = this.generation;
    const requestFamily = this.activeFamily;
    const requestServer = this.activeServer;
    let result;
    try {
      result = await requestServer.translate(type, payload, options);
    } catch (error) {
      const reason = requestFamily === 'cuda' ? cudaFailureReason(error) : null;
      if (!reason) throw error;
      await this.fallbackToCpu(reason, requestGeneration);
      if (type !== 'translate.final') throw abortError();

      const retryGeneration = this.generation;
      try {
        result = await this.cpuServer.translate(type, payload, options);
      } catch (cpuError) {
        throw attachFallbackReason(cpuError, this.fallbackReason);
      }
      if (retryGeneration !== this.generation) throw abortError();
      return this.mergeProvenance(result);
    }
    if (requestGeneration !== this.generation) throw abortError();
    return this.mergeProvenance(result);
  }

  fallbackToCpu(reason, requestGeneration) {
    if (this.fallbackPromise) return this.fallbackPromise;
    if (this.activeFamily === 'cpu') return Promise.resolve(this.health());
    if (requestGeneration !== this.generation && this.cudaRetired) {
      return Promise.resolve(this.health());
    }

    const lifecycle = this.lifecycleVersion;
    const retiredServer = this.activeServer || this.cudaServer;
    this.activeFamily = null;
    this.activeServer = null;
    this.retireCuda(reason);

    let fallbackPromise;
    fallbackPromise = (async () => {
      await retiredServer.stop();
      this.assertLifecycle(lifecycle);
      return this.startCpu(lifecycle);
    })().finally(() => {
      if (this.fallbackPromise === fallbackPromise) this.fallbackPromise = null;
    });
    this.fallbackPromise = fallbackPromise;
    return fallbackPromise;
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.lifecycleVersion += 1;
    this.generation += 1;
    const servers = [...new Set([
      this.activeServer,
      this.startingServer,
    ].filter(Boolean))];
    this.activeFamily = null;
    this.activeServer = null;
    this.startPromise = null;
    this.fallbackPromise = null;

    let stopPromise;
    stopPromise = (async () => {
      await Promise.allSettled(servers.map(server => server.stop()));
    })().finally(() => {
      if (this.stopPromise === stopPromise) this.stopPromise = null;
    });
    this.stopPromise = stopPromise;
    return stopPromise;
  }

  assertLifecycle(expected) {
    if (expected !== this.lifecycleVersion) {
      throw abortError('Local translation lifecycle changed');
    }
  }
}

module.exports = {
  HyMt2RuntimeController,
};
