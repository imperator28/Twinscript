const { LocalInferenceSupervisor } = require('./local-inference-supervisor');
const { resolveLocalInferencePaths } = require('./local-inference-paths');
const { LocalModelAdmissionGate } = require('./local-model-admission');
const { loadLocalModelCatalog } = require('./local-model-manifest-loader');
const { LocalModelManager } = require('./local-model-manager');
const { LocalModelService } = require('./local-model-service');

function createLocalInferenceRuntime(options, dependencies = {}) {
  const loadCatalog = dependencies.loadCatalog || loadLocalModelCatalog;
  const resolvePaths = dependencies.resolvePaths || resolveLocalInferencePaths;
  const Manager = dependencies.LocalModelManager || LocalModelManager;
  const Service = dependencies.LocalModelService || LocalModelService;
  const Supervisor = dependencies.LocalInferenceSupervisor || LocalInferenceSupervisor;
  const Gate = dependencies.LocalModelAdmissionGate || LocalModelAdmissionGate;
  const catalog = loadCatalog(options);
  const paths = resolvePaths({ ...options, manifest: catalog.manifest });
  const admissionGate = new Gate();
  let sessionManager = null;
  const manager = catalog.available
    ? new Manager({
        manifest: catalog.manifest,
        root: paths.modelRoot,
        sessionActive: () => Boolean(sessionManager?.isActive?.()),
      })
    : null;
  const service = new Service({
    catalog,
    manager,
    admissionGate,
    isMeetingActive: () => Boolean(sessionManager?.isActive?.()),
  });
  const supervisor = new Supervisor({
    ...options,
    ...paths,
    modelReady: (modelId) => service.modelReady(modelId),
    whisperDevice: 'NPU',
  });
  service.supervisor = supervisor;
  return {
    catalog,
    paths,
    admissionGate,
    manager,
    service,
    supervisor,
    attachSessionManager(value) {
      sessionManager = value;
    },
  };
}

module.exports = { createLocalInferenceRuntime };
