const { EventEmitter } = require('events');
const { ALLOWED_MODEL_IDS } = require('./local-model-manifest');

const CATALOG_UNAVAILABLE = {
  code: 'local_catalog_unavailable',
  message: 'Local model downloads are unavailable in this build.',
};

function serviceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeError(error) {
  if (!error) return null;
  return {
    code: typeof error.code === 'string' ? error.code : 'local_model_failed',
    message: 'Local model operation failed.',
  };
}

function safeExpectedDevice(device) {
  return ['NPU', 'GPU', 'CPU'].includes(device) ? device : null;
}

function safeActualDevice(modelId, device) {
  const allowed = modelId === 'hy-mt2-1.8b' ? ['CUDA0', 'CPU'] : ['NPU', 'CPU'];
  return allowed.includes(device) ? device : null;
}

function safeRequestedDevice(modelId, device) {
  const allowed = modelId === 'hy-mt2-1.8b' ? ['CUDA_AUTO', 'CPU'] : ['NPU', 'CPU'];
  return allowed.includes(device) ? device : null;
}

function safeDeviceName(value, actualDevice) {
  if (actualDevice !== 'CUDA0' || typeof value !== 'string' || !value.trim()) return null;
  const name = value.trim();
  if (!/\bNVIDIA\b/i.test(name) || /[\\/\r\n]/.test(name)) return null;
  return name.slice(0, 160);
}

function safeOffload(value) {
  return ['full', 'partial', 'none', 'unknown'].includes(value) ? value : 'unknown';
}

function safeFallbackReason(value) {
  if (value == null) return null;
  return /^[a-z0-9_]{1,80}$/.test(value) ? value : null;
}

function safeLoadMs(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function safeRuntimeModel(modelId, runtime = {}) {
  const actualDevice = safeActualDevice(modelId, runtime.actualDevice);
  return {
    actualDevice,
    requestedDevice: safeRequestedDevice(modelId, runtime.requestedDevice),
    deviceName: modelId === 'hy-mt2-1.8b' ? safeDeviceName(runtime.deviceName, actualDevice) : null,
    offload: modelId === 'hy-mt2-1.8b' ? safeOffload(runtime.offload) : 'unknown',
    fallbackReason: modelId === 'hy-mt2-1.8b' ? safeFallbackReason(runtime.fallbackReason) : null,
    loadMs: modelId === 'hy-mt2-1.8b' ? safeLoadMs(runtime.loadMs) : null,
  };
}

function unavailableModel(modelId, runtime = {}) {
  return {
    id: modelId,
    version: null,
    phase: 'unavailable',
    ready: false,
    installed: false,
    verified: false,
    ...safeRuntimeModel(modelId, runtime),
    error: CATALOG_UNAVAILABLE,
  };
}

function rendererModel(model = {}, runtime, catalogModel) {
  return {
    id: catalogModel.id,
    displayName: catalogModel.displayName,
    purpose: catalogModel.purpose,
    expectedDevice: safeExpectedDevice(catalogModel.expectedDevice),
    version: catalogModel.version,
    downloadBytes: model.downloadBytes,
    installedBytes: model.installedBytes,
    downloadedBytes: model.downloadedBytes,
    installed: model.installed === true,
    verified: model.verified === true,
    phase: model.phase,
    ready: model.ready === true,
    repairRecommended: model.repairRecommended === true,
    error: safeError(model.error),
    ...safeRuntimeModel(catalogModel.id, runtime),
  };
}

class LocalModelService extends EventEmitter {
  constructor({
    catalog,
    manager = null,
    sessionManager = null,
    supervisor = null,
    admissionGate = null,
    isMeetingActive = null,
    runtimeManager = null,
    refreshRuntime = null,
    runtimeSupported = process.platform === 'win32',
  } = {}) {
    super();
    this.catalog = catalog || {
      available: false,
      root: null,
      manifest: null,
      error: CATALOG_UNAVAILABLE,
    };
    this.manager = manager;
    this.sessionManager = sessionManager;
    this.supervisor = supervisor;
    this.admissionGate = admissionGate;
    this.isMeetingActive = isMeetingActive;
    this.runtimeManager = runtimeManager;
    this.refreshRuntime = refreshRuntime;
    this.runtimeSupported = runtimeSupported;
    this.cudaAvailable = false;
  }

  modelReady(modelId) {
    return Boolean(this.manager?.status().models?.[modelId]?.ready);
  }

  isKnownModel(modelId) {
    return Boolean(this.catalog.manifest?.models?.some((model) => model.id === modelId));
  }

  async run(operation, modelId) {
    if (!this.catalog.available || !this.manager) {
      throw serviceError(CATALOG_UNAVAILABLE.code, CATALOG_UNAVAILABLE.message);
    }
    if (!this.isKnownModel(modelId)) {
      throw serviceError('local_model_unknown', 'Unknown local model: ' + modelId);
    }
    const model = this.catalog.manifest.models.find((candidate) => candidate.id === modelId);
    if (operation === 'download' && model?.localOnly === true) {
      throw serviceError('local_model_local_files_only', 'This development model must be added from local files.');
    }
    if (operation === 'adopt' && this.catalog.localAdoptionAvailable !== true) {
      throw serviceError('local_model_adoption_unavailable', 'Local file adoption is unavailable in this build.');
    }
    const execute = async () => {
      if (this.isMeetingActive?.() || this.sessionManager?.isActive?.()) {
        throw serviceError('meeting_active', 'Local models cannot change during a meeting');
      }
      try {
        return await this.manager[operation](modelId);
      } finally {
        this.publishStatus();
      }
    };
    return this.admissionGate ? this.admissionGate.runMutation(execute) : execute();
  }

  publishStatus() {
    const status = this.status();
    this.emit('status', status);
    return status;
  }

  status() {
    const meetingActive = Boolean(this.isMeetingActive?.() || this.sessionManager?.isActive?.());
    const actionLocks = {
      meetingActive,
      download: meetingActive || !this.catalog.available || this.catalog.manifest?.models?.every((model) => model.localOnly === true),
      verify: meetingActive || !this.catalog.available,
      repair: meetingActive || !this.catalog.available,
      remove: meetingActive || !this.catalog.available,
      adopt: meetingActive || !this.catalog.available || this.catalog.localAdoptionAvailable !== true,
    };
    const readiness = this.supervisor?.readiness?.() || {
      runtimeReady: false,
      requestedDevice: null,
      models: {},
    };
    if (!this.catalog.available || !this.manager) {
      return {
        catalog: {
          available: false,
          localAdoptionAvailable: false,
          error: CATALOG_UNAVAILABLE,
        },
        runtime: {
          ready: Boolean(readiness.runtimeReady),
          supported: this.runtimeSupported,
          cudaAvailable: this.cudaAvailable,
          bundles: this.runtimeManager?.status?.() || {},
          requestedDevice: safeExpectedDevice(readiness.requestedDevice) || 'NPU',
        },
        models: Object.fromEntries(ALLOWED_MODEL_IDS.map((modelId) => [
          modelId,
          unavailableModel(modelId, readiness.models?.[modelId]),
        ])),
        actionLocks,
      };
    }

    const lifecycle = this.manager.status();
    return {
      catalog: {
        available: true,
        localAdoptionAvailable: this.catalog.localAdoptionAvailable === true,
        error: null,
      },
      runtime: {
        ready: Boolean(readiness.runtimeReady),
        supported: this.runtimeSupported,
        cudaAvailable: this.cudaAvailable,
        bundles: this.runtimeManager?.status?.() || {},
        requestedDevice: safeExpectedDevice(readiness.requestedDevice) || 'NPU',
      },
      models: Object.fromEntries(this.catalog.manifest.models.map((model) => [
        model.id,
        rendererModel(
          lifecycle.models?.[model.id],
          readiness.models?.[model.id],
          model,
        ),
      ])),
      actionLocks,
    };
  }

  install(modelId) {
    return this.run('download', modelId);
  }

  async runtimeAction(operation, runtimeId) {
    if (!this.runtimeSupported || !this.runtimeManager) throw serviceError('local_runtime_unavailable', 'Local runtime installation is unavailable on this platform or in this build.');
    if (!['install', 'verify', 'remove', 'cancel'].includes(operation)) throw serviceError('local_runtime_unknown', 'Unknown runtime action.');
    if (runtimeId === 'cuda' && operation === 'install' && !this.cudaAvailable) throw serviceError('local_runtime_device_unavailable', 'A compatible NVIDIA device has not been detected.');
    if (operation === 'cancel') return this.runtimeManager.cancel(runtimeId);
    const execute = async () => {
      if (this.isMeetingActive?.() || this.sessionManager?.isActive?.()) throw serviceError('meeting_active', 'End the meeting before changing local runtimes.');
      try {
        if (this.supervisor?.suspendRuntime) await this.supervisor.suspendRuntime();
        else await this.supervisor?.dispose?.();
        return await this.runtimeManager[operation](runtimeId);
      } finally {
        await this.refreshRuntime?.();
        this.publishStatus();
      }
    };
    return this.admissionGate ? this.admissionGate.runMutation(execute) : execute();
  }

  adopt(modelId) {
    return this.run('adopt', modelId);
  }

  verify(modelId) {
    return this.run('verify', modelId);
  }

  repair(modelId) {
    return this.run('repair', modelId);
  }

  remove(modelId) {
    return this.run('remove', modelId);
  }
}

module.exports = { LocalModelService };
