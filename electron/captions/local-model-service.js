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

function safeDevice(device) {
  return ['NPU', 'GPU', 'CPU'].includes(device) ? device : null;
}

function unavailableModel(modelId, actualDevice = null) {
  return {
    id: modelId,
    phase: 'unavailable',
    ready: false,
    actualDevice: safeDevice(actualDevice),
    error: CATALOG_UNAVAILABLE,
  };
}

function rendererModel(model, actualDevice) {
  return {
    id: model.id,
    displayName: model.displayName,
    purpose: model.purpose,
    expectedDevice: safeDevice(model.expectedDevice),
    downloadBytes: model.downloadBytes,
    installedBytes: model.installedBytes,
    downloadedBytes: model.downloadedBytes,
    phase: model.phase,
    ready: model.ready === true,
    repairRecommended: model.repairRecommended === true,
    error: safeError(model.error),
    actualDevice: safeDevice(actualDevice),
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
    const execute = async () => {
      if (this.isMeetingActive?.() || this.sessionManager?.isActive?.()) {
        throw serviceError('meeting_active', 'Local models cannot change during a meeting');
      }
      try {
        return await this.manager[operation](modelId);
      } finally {
        this.emit('status', this.status());
      }
    };
    return this.admissionGate ? this.admissionGate.runMutation(execute) : execute();
  }

  status() {
    const meetingActive = Boolean(this.isMeetingActive?.() || this.sessionManager?.isActive?.());
    const actionLocks = {
      meetingActive,
      download: meetingActive || !this.catalog.available,
      verify: meetingActive || !this.catalog.available,
      repair: meetingActive || !this.catalog.available,
      remove: meetingActive || !this.catalog.available,
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
          error: CATALOG_UNAVAILABLE,
        },
        runtime: {
          ready: Boolean(readiness.runtimeReady),
          requestedDevice: safeDevice(readiness.requestedDevice) || 'NPU',
        },
        models: Object.fromEntries(ALLOWED_MODEL_IDS.map((modelId) => [
          modelId,
          unavailableModel(modelId, readiness.models?.[modelId]?.actualDevice),
        ])),
        actionLocks,
      };
    }

    const lifecycle = this.manager.status();
    return {
      catalog: {
        available: true,
        error: null,
      },
      runtime: {
        ready: Boolean(readiness.runtimeReady),
        requestedDevice: safeDevice(readiness.requestedDevice) || 'NPU',
      },
      models: Object.fromEntries(Object.entries(lifecycle.models).map(([modelId, model]) => [
        modelId,
        rendererModel(model, readiness.models?.[modelId]?.actualDevice),
      ])),
      actionLocks,
    };
  }

  install(modelId) {
    return this.run('download', modelId);
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
