const { LocalInferenceSupervisor } = require('./local-inference-supervisor');
const { resolveLocalInferencePaths } = require('./local-inference-paths');
const { LocalModelAdmissionGate } = require('./local-model-admission');
const { loadLocalModelCatalog } = require('./local-model-manifest-loader');
const { LocalModelManager } = require('./local-model-manager');
const { LocalModelService } = require('./local-model-service');
const { LocalRuntimeManager } = require('./local-runtime-manager');
const { verifyRuntimeManifest } = require('./local-inference-supervisor');
const path = require('node:path');
const { detectNvidiaHardware } = require('./nvidia-hardware');

function defaultHyMt2CudaEnabled({ platform = process.platform, env = process.env } = {}) {
  return platform === 'win32' && env.TWINSCRIPT_DISABLE_HYMT2_CUDA !== '1';
}

function createLocalInferenceRuntime(options, dependencies = {}) {
  const loadCatalog = dependencies.loadCatalog || loadLocalModelCatalog;
  const resolvePaths = dependencies.resolvePaths || resolveLocalInferencePaths;
  const Manager = dependencies.LocalModelManager || LocalModelManager;
  const Service = dependencies.LocalModelService || LocalModelService;
  const Supervisor = dependencies.LocalInferenceSupervisor || LocalInferenceSupervisor;
  const Gate = dependencies.LocalModelAdmissionGate || LocalModelAdmissionGate;
  const RuntimeManager = dependencies.LocalRuntimeManager || LocalRuntimeManager;
  const catalog = loadCatalog(options);
  const paths = resolvePaths({ ...options, manifest: catalog.manifest });
  const admissionGate = new Gate();
  let sessionManager = null;
  // The manager is constructed before its service, so progress closes over this
  // binding and begins publishing only after the service exists.
  let service = null;
  const manager = catalog.available
    ? new Manager({
        manifest: catalog.manifest,
        root: paths.modelRoot,
        sessionActive: () => Boolean(sessionManager?.isActive?.()),
        onProgress: ({ phase }) => {
          // The manager's ready event is terminal; run() publishes that final
          // snapshot in its finally block. Forward only ongoing phases here.
          if (phase === 'downloading' || phase === 'verifying') {
            service?.publishStatus?.();
          }
        },
      })
    : null;
  const runtimeManager = catalog.available && options.userDataPath && catalog.manifest.runtimes?.length
    ? new RuntimeManager({
        runtimes: catalog.manifest.runtimes,
        root: path.join(options.userDataPath, 'local-inference-host'),
        sessionActive: () => Boolean(sessionManager?.isActive?.()),
        verifyRuntime: verifyRuntimeManifest,
        onProgress: () => service?.publishStatus?.(),
      })
    : null;
  service = new Service({
    catalog,
    manager,
    admissionGate,
    runtimeManager,
    runtimeSupported: (options.platform || process.platform) === 'win32',
    refreshRuntime: async () => {
      const refreshed = resolvePaths({ ...options, manifest: catalog.manifest });
      await supervisor.refreshRuntimePaths(refreshed);
      Object.assign(paths, refreshed);
    },
    isMeetingActive: () => Boolean(sessionManager?.isActive?.()),
  });
  const supervisor = new Supervisor({
    ...options,
    ...paths,
    modelReady: (modelId) => service.modelReady(modelId),
    whisperDevice: 'NPU',
  });
  service.supervisor = supervisor;
  if (runtimeManager && (options.platform || process.platform) === 'win32') {
    const detectHardware = dependencies.detectNvidiaHardware || detectNvidiaHardware;
    Promise.resolve(detectHardware()).then(available => {
      service.cudaAvailable = available === true;
      service.publishStatus?.();
    }).catch(() => {});
  }
  supervisor.on?.('model-status', () => service.publishStatus?.());
  return {
    catalog,
    paths,
    admissionGate,
    manager,
    runtimeManager,
    service,
    supervisor,
    attachSessionManager(value) {
      sessionManager = value;
    },
  };
}

module.exports = { createLocalInferenceRuntime, defaultHyMt2CudaEnabled };
