const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

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
    cudaEnabled: true,
  }, {
    loadCatalog: (options) => {
      calls.catalog = options;
      return { available: true, root: 'C:\\catalog', manifest, error: null };
    },
    resolvePaths: (options) => {
      calls.paths = options;
      return {
        modelRoot: 'C:\\user\\local-models',
        whisperModelPath: 'whisper-path',
        llamaCpuBinaryPath: 'llama-cpu-path',
        llamaCudaBinaryPath: 'llama-cuda-path',
      };
    },
    LocalModelManager: Manager,
    LocalModelService: Service,
    LocalInferenceSupervisor: Supervisor,
  });

  assert.equal(calls.paths.manifest, manifest);
  assert.equal(calls.manager.manifest, manifest);
  assert.equal(calls.manager.root, 'C:\\user\\local-models');
  assert.equal(calls.supervisor.whisperModelPath, 'whisper-path');
  assert.equal(calls.supervisor.llamaCpuBinaryPath, 'llama-cpu-path');
  assert.equal(calls.supervisor.llamaCudaBinaryPath, 'llama-cuda-path');
  assert.equal(calls.supervisor.cudaEnabled, true);
  assert.equal(calls.supervisor.modelReady('whisper-small'), true);
  assert.equal(calls.supervisor.modelReady('hy-mt2-1.8b'), false);
  assert.equal(runtime.supervisor instanceof Supervisor, true);
  assert.equal(runtime.service.supervisor, runtime.supervisor);
  assert.equal(typeof runtime.attachSessionManager, 'function');
});

test('controller model-status publishes a fresh service snapshot and is removed on supervisor disposal', async () => {
  let publications = 0;
  class Service {
    constructor() {}
    modelReady() { return true; }
    publishStatus() { publications += 1; }
  }
  class Supervisor extends EventEmitter {
    constructor() { super(); }
    async dispose() { this.removeAllListeners(); }
  }
  const runtime = createLocalInferenceRuntime({}, {
    loadCatalog: () => ({ available: false, manifest: null, error: null }),
    resolvePaths: () => ({ modelRoot: 'models' }),
    LocalModelService: Service,
    LocalInferenceSupervisor: Supervisor,
  });

  runtime.supervisor.emit('model-status', { id: 'hy-mt2-1.8b', actualDevice: 'CUDA0' });
  assert.equal(publications, 1);

  await runtime.supervisor.dispose();
  runtime.supervisor.emit('model-status', { id: 'hy-mt2-1.8b', actualDevice: 'CPU' });
  assert.equal(publications, 1);
});

test('manager progress publishes ongoing service snapshots and one terminal ready snapshot', async () => {
  const manifest = {
    runtimeVersion: '2026.8.10',
    models: [
      { id: 'whisper-small', version: 'whisper-v2', displayName: 'Whisper Small', purpose: 'Speech recognition', expectedDevice: 'NPU', files: [] },
      { id: 'hy-mt2-1.8b', version: 'hymt2-v2', displayName: 'HY-MT2 1.8B', purpose: 'Translation', expectedDevice: 'GPU', files: [] },
    ],
  };
  class Manager {
    constructor({ onProgress }) {
      this.onProgress = onProgress;
      this.phase = 'not-installed';
    }

    status() {
      return {
        models: {
          'whisper-small': {
            id: 'whisper-small', phase: this.phase, ready: this.phase === 'ready',
            version: 'private-manager-version', installedBytes: 0, downloadedBytes: 0,
          },
          'hy-mt2-1.8b': { id: 'hy-mt2-1.8b', phase: 'not-installed', ready: false },
        },
      };
    }

    async download() {
      for (const phase of ['downloading', 'verifying', 'ready']) {
        this.phase = phase;
        this.onProgress?.({ modelId: 'whisper-small', phase, downloadedBytes: 1, totalBytes: 1 });
      }
    }
  }
  class Supervisor {
    constructor() {}
  }
  const runtime = createLocalInferenceRuntime({
    isPackaged: true,
    resourcesPath: 'C:\\resources',
    appPath: 'C:\\app',
    userDataPath: 'C:\\user',
  }, {
    loadCatalog: () => ({ available: true, manifest, error: null }),
    resolvePaths: () => ({ modelRoot: 'C:\\user\\local-models' }),
    LocalModelManager: Manager,
    LocalInferenceSupervisor: Supervisor,
  });
  const phases = [];
  runtime.service.on('status', (status) => phases.push(status.models['whisper-small'].phase));

  await runtime.service.install('whisper-small');

  assert.deepEqual(phases, ['downloading', 'verifying', 'ready']);
  assert.equal(phases.filter((phase) => phase === 'ready').length, 1);
  // A remounted renderer can fetch the latest public snapshot after missing updates.
  assert.equal(runtime.service.status().models['whisper-small'].phase, 'ready');
  assert.equal(runtime.service.status().models['whisper-small'].version, 'whisper-v2');
});
