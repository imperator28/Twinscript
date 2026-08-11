const assert = require('node:assert/strict');
const test = require('node:test');

const { createLocalInferenceRuntime } = require('./local-inference-runtime');

test('bootstrap derives paths and packaged readiness from the loaded catalog', () => {
  const calls = {};
  const manifest = {
    runtimeVersion: '2026.8.10',
    models: [
      { id: 'whisper-small', version: 'whisper-v2', launchPath: '.', files: [] },
      { id: 'hy-mt2-1.8b', version: 'hymt2-v2', launchPath: 'model.gguf', files: [] },
    ],
  };
  class Manager {
    constructor(options) {
      calls.manager = options;
    }
  }
  class Service {
    constructor(options) {
      calls.service = options;
    }

    modelReady(modelId) {
      return modelId === 'whisper-small';
    }
  }
  class Supervisor {
    constructor(options) {
      calls.supervisor = options;
    }
  }
  const runtime = createLocalInferenceRuntime({
    isPackaged: true,
    resourcesPath: 'C:\\resources',
    appPath: 'C:\\app',
    userDataPath: 'C:\\user',
  }, {
    loadCatalog: (options) => {
      calls.catalog = options;
      return { available: true, root: 'C:\\catalog', manifest, error: null };
    },
    resolvePaths: (options) => {
      calls.paths = options;
      return { modelRoot: 'C:\\user\\local-models', whisperModelPath: 'whisper-path' };
    },
    LocalModelManager: Manager,
    LocalModelService: Service,
    LocalInferenceSupervisor: Supervisor,
  });

  assert.equal(calls.paths.manifest, manifest);
  assert.equal(calls.manager.manifest, manifest);
  assert.equal(calls.manager.root, 'C:\\user\\local-models');
  assert.equal(calls.supervisor.whisperModelPath, 'whisper-path');
  assert.equal(calls.supervisor.modelReady('whisper-small'), true);
  assert.equal(calls.supervisor.modelReady('hy-mt2-1.8b'), false);
  assert.equal(runtime.supervisor instanceof Supervisor, true);
  assert.equal(runtime.service.supervisor, runtime.supervisor);
  assert.equal(typeof runtime.attachSessionManager, 'function');
});
