const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LocalInferenceSupervisor,
  hasVerifiedMarker,
  resolveLocalInferenceExecutable,
  verifyRuntimeManifest,
} = require('./local-inference-supervisor');
const { HyMt2RuntimeController } = require('./hy-mt2-runtime-controller');
const { LlamaCudaProbe } = require('./llama-runtime-probe');
const { CUDA_RUNTIME, CPU_RUNTIME, LlamaTranslationServer } = require('./llama-translation-client');


test('supervisor discards replies from a replaced host generation', () => {
  const supervisor = new LocalInferenceSupervisor({ spawn: () => { throw new Error('unused'); } });
  supervisor.generation = 1;
  assert.equal(supervisor.accept({ generation: 1, type: 'asr.result' }), true);

  supervisor.generation = 2;

  assert.equal(supervisor.accept({ generation: 1, type: 'asr.result' }), false);
  assert.equal(supervisor.accept({ generation: 2, type: 'asr.result' }), true);
});

test('packaged and development executable paths are explicit', () => {
  assert.equal(
    resolveLocalInferenceExecutable({
      isPackaged: true,
      resourcesPath: 'C:\\Program Files\\TwinScript\\resources',
      appPath: 'unused',
    }),
    'C:\\Program Files\\TwinScript\\resources\\local-inference-host\\twinscript-local-inference.exe',
  );
  assert.equal(
    resolveLocalInferenceExecutable({
      isPackaged: false,
      resourcesPath: 'unused',
      appPath: 'C:\\repo',
    }),
    'C:\\repo\\artifacts\\local-inference-host\\twinscript-local-inference.exe',
  );
});

test('supervisor permits only one in-session restart', async () => {
  const supervisor = new LocalInferenceSupervisor({ spawn: () => { throw new Error('unused'); } });
  supervisor.restartCount = 1;

  await assert.rejects(supervisor.restart(), { code: 'local_host_restart_exhausted' });
});

test('transport labels replies with the generation that spawned the process', () => {
  const supervisor = new LocalInferenceSupervisor({ spawn: () => { throw new Error('unused'); } });
  const child = {
    stdin: { write() {} },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    once() {},
  };
  const accepted = [];
  supervisor.generation = 1;
  const transport = supervisor.createTransport(child, 1);
  transport.on('message', (message) => accepted.push(message));
  supervisor.generation = 2;

  child.stdout.emit('data', Buffer.from('{"type":"health"}\n'));

  assert.deepEqual(accepted, []);
});

test('an unexpected active-host close triggers the one supervised restart', async () => {
  const supervisor = new LocalInferenceSupervisor({ spawn: () => { throw new Error('unused'); } });
  const child = new EventEmitter();
  child.stdin = { write() {} };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  supervisor.generation = 1;
  supervisor.requestedModels = ['whisper-small'];
  let restarted = 0;
  supervisor.restart = async () => { restarted += 1; };

  supervisor.createTransport(child, 1);
  child.emit('close');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(restarted, 1);
});

test('prepare starts Hy-MT2 only when selected and exposes the hybrid client', async () => {
  const calls = [];
  const translationRuntime = {
    beginSession: async (sessionId) => calls.push(['translation:session', sessionId]),
    start: async () => calls.push('translation:start'),
    translate: async () => ({ text: 'local' }),
    health: () => ({ id: 'hy-mt2-1.8b', actualDevice: 'CPU' }),
    stop: async () => calls.push('translation:stop'),
  };
  const supervisor = new LocalInferenceSupervisor({
    spawn: () => { throw new Error('unused'); },
    translationRuntime,
  });
  supervisor.baseClient = {
    request: async (type, payload) => {
      calls.push([type, payload.models]);
      return { type: 'model.ready', models: [] };
    },
    on() {}, off() {}, dispose() {},
  };
  supervisor.activeClient = supervisor.createHybridClient();

  await supervisor.prepare(['hy-mt2-1.8b'], 's1');
  const result = await supervisor.client().request('translate.final', { text: 'one' });

  assert.equal(result.text, 'local');
  assert.deepEqual(calls, [
    ['translation:session', 's1'],
    'translation:start',
    ['model.prepare', []],
  ]);
});

test('supervisor composes CPU, optional CUDA, probe, and session controller', () => {
  const supervisor = new LocalInferenceSupervisor({
    llamaCpuBinaryPath: 'llama-cpu.exe',
    llamaCudaBinaryPath: 'llama-cuda.exe',
    hyMt2ModelPath: 'hy.gguf',
    cudaEnabled: true,
  });

  assert.equal(supervisor.translationRuntime instanceof HyMt2RuntimeController, true);
  assert.equal(supervisor.translationRuntime.enabled, true);
  assert.equal(supervisor.translationRuntime.cpuServer instanceof LlamaTranslationServer, true);
  assert.equal(supervisor.translationRuntime.cpuServer.binaryPath, 'llama-cpu.exe');
  assert.equal(supervisor.translationRuntime.cpuServer.modelPath, 'hy.gguf');
  assert.deepEqual(supervisor.translationRuntime.cpuServer.runtimeDescriptor, CPU_RUNTIME);
  assert.equal(supervisor.translationRuntime.cudaServer instanceof LlamaTranslationServer, true);
  assert.equal(supervisor.translationRuntime.cudaServer.binaryPath, 'llama-cuda.exe');
  assert.deepEqual(supervisor.translationRuntime.cudaServer.runtimeDescriptor, CUDA_RUNTIME);
  assert.equal(supervisor.translationRuntime.cudaServer.maxRestarts, 0);
  assert.equal(supervisor.translationRuntime.probe instanceof LlamaCudaProbe, true);
  assert.equal(supervisor.translationRuntime.probe.binaryPath, 'llama-cuda.exe');
});

test('supervisor composes CPU-only controller when optional CUDA runtime is absent', () => {
  const supervisor = new LocalInferenceSupervisor({
    llamaCpuBinaryPath: 'llama-cpu.exe',
    hyMt2ModelPath: 'hy.gguf',
    cudaEnabled: true,
  });

  assert.equal(supervisor.translationRuntime instanceof HyMt2RuntimeController, true);
  assert.equal(supervisor.translationRuntime.cpuServer.binaryPath, 'llama-cpu.exe');
  assert.equal(supervisor.translationRuntime.cudaServer, null);
  assert.equal(supervisor.translationRuntime.probe, null);
});

test('controller status updates readiness evidence and emits sanitized model status', () => {
  const translationRuntime = new EventEmitter();
  translationRuntime.health = () => ({
    id: 'hy-mt2-1.8b', ready: true, requestedDevice: 'CUDA_AUTO', actualDevice: 'CUDA0',
    offload: 'full', fallbackReason: null,
  });
  translationRuntime.stop = async () => {};
  const supervisor = new LocalInferenceSupervisor({
    executablePath: 'host.exe',
    llamaCpuBinaryPath: 'llama-cpu.exe',
    hyMt2ModelPath: 'hy.gguf',
    translationRuntime,
    exists: () => true,
    artifactReady: () => true,
  });
  const seen = [];
  supervisor.on('model-status', model => seen.push(model));

  translationRuntime.emit('status', translationRuntime.health());

  assert.equal(supervisor.lastModels.get('hy-mt2-1.8b').actualDevice, 'CUDA0');
  assert.equal(supervisor.readiness().models['hy-mt2-1.8b'].actualDevice, 'CUDA0');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].offload, 'full');

  translationRuntime.health = () => ({
    id: 'hy-mt2-1.8b', ready: false, requestedDevice: 'CUDA_AUTO', actualDevice: null,
    offload: 'unknown', fallbackReason: null,
  });
  assert.equal(
    supervisor.readiness().models['hy-mt2-1.8b'].actualDevice,
    null,
    'current controller health must outrank the previous session snapshot',
  );
});

test('development Hy-MT2 readiness requires the CPU runtime but not CUDA', () => {
  const present = new Set(['host.exe', 'whisper', 'llama-cpu.exe', 'hy.gguf']);
  const supervisor = new LocalInferenceSupervisor({
    executablePath: 'host.exe',
    whisperModelPath: 'whisper',
    llamaCpuBinaryPath: 'llama-cpu.exe',
    llamaCudaBinaryPath: 'llama-cuda.exe',
    hyMt2ModelPath: 'hy.gguf',
    exists: (candidate) => present.has(candidate),
    artifactReady: (kind, candidate) => kind === 'runtime'
      ? present.has(candidate)
      : kind === 'whisper-small'
        ? present.has(candidate)
        : present.has(candidate),
  });

  assert.deepEqual(supervisor.readiness(), {
    runtimeReady: true,
    requestedDevice: 'NPU',
    models: {
      'whisper-small': { ready: true, actualDevice: null },
      'hy-mt2-1.8b': { ready: true, actualDevice: null },
    },
  });
});

test('installed Hy-MT2 has no CUDA device assignment before runtime health evidence', () => {
  const present = new Set(['host.exe', 'llama-cpu.exe', 'llama-cuda.exe', 'hy.gguf']);
  const supervisor = new LocalInferenceSupervisor({
    executablePath: 'host.exe',
    llamaCpuBinaryPath: 'llama-cpu.exe',
    llamaCudaBinaryPath: 'llama-cuda.exe',
    hyMt2ModelPath: 'hy.gguf',
    exists: (candidate) => present.has(candidate),
    artifactReady: (kind, candidate) => kind === 'runtime' || kind === 'hy-mt2-1.8b'
      ? present.has(candidate)
      : false,
  });

  const readiness = supervisor.readiness();

  assert.equal(readiness.models['hy-mt2-1.8b'].ready, true);
  assert.equal(readiness.models['hy-mt2-1.8b'].actualDevice, null);
});

test('development Hy-MT2 readiness fails when only CUDA is installed', () => {
  const present = new Set(['host.exe', 'llama-cuda.exe', 'hy.gguf']);
  const supervisor = new LocalInferenceSupervisor({
    executablePath: 'host.exe',
    llamaCpuBinaryPath: 'llama-cpu.exe',
    llamaCudaBinaryPath: 'llama-cuda.exe',
    hyMt2ModelPath: 'hy.gguf',
    exists: (candidate) => present.has(candidate),
    artifactReady: (kind, candidate) => kind === 'runtime' || kind === 'hy-mt2-1.8b'
      ? present.has(candidate)
      : false,
  });

  const readiness = supervisor.readiness();

  assert.equal(readiness.models['hy-mt2-1.8b'].ready, false);
  assert.equal(readiness.models['hy-mt2-1.8b'].actualDevice, null);
});

test('packaged model readiness delegates to the lifecycle service', () => {
  const calls = [];
  const present = new Set(['host.exe', 'llama-cpu.exe']);
  const supervisor = new LocalInferenceSupervisor({
    isPackaged: true,
    executablePath: 'host.exe',
    whisperModelPath: 'whisper',
    llamaCpuBinaryPath: 'llama-cpu.exe',
    llamaCudaBinaryPath: 'llama-cuda.exe',
    hyMt2ModelPath: 'hy.gguf',
    modelReady: (modelId) => {
      calls.push(modelId);
      return modelId === 'whisper-small';
    },
    exists: (candidate) => present.has(candidate),
    artifactReady: (kind, candidate) => kind === 'runtime' && present.has(candidate),
  });

  const readiness = supervisor.readiness();

  assert.equal(readiness.models['whisper-small'].ready, true);
  assert.equal(readiness.models['hy-mt2-1.8b'].ready, false);
  assert.equal(readiness.models['hy-mt2-1.8b'].actualDevice, null);
  assert.deepEqual(calls, ['whisper-small', 'hy-mt2-1.8b']);
});

test('packaged Hy-MT2 readiness requires the CPU runtime after lifecycle verification', () => {
  const present = new Set(['host.exe', 'llama-cuda.exe']);
  const supervisor = new LocalInferenceSupervisor({
    isPackaged: true,
    executablePath: 'host.exe',
    llamaCpuBinaryPath: 'llama-cpu.exe',
    llamaCudaBinaryPath: 'llama-cuda.exe',
    hyMt2ModelPath: 'hy.gguf',
    exists: (candidate) => present.has(candidate),
    artifactReady: (kind, candidate) => kind === 'runtime' && present.has(candidate),
    modelReady: (modelId) => modelId === 'hy-mt2-1.8b',
  });

  const readiness = supervisor.readiness();

  assert.equal(readiness.models['hy-mt2-1.8b'].ready, false);
  assert.equal(readiness.models['hy-mt2-1.8b'].actualDevice, null);
});

test('packaged model readiness fails closed when the lifecycle service is unavailable', () => {
  const supervisor = new LocalInferenceSupervisor({
    isPackaged: true,
    executablePath: 'host.exe',
    whisperModelPath: 'whisper',
    hyMt2ModelPath: 'hy.gguf',
    artifactReady: () => true,
  });

  const readiness = supervisor.readiness();

  assert.equal(readiness.models['whisper-small'].ready, false);
  assert.equal(readiness.models['hy-mt2-1.8b'].ready, false);
});

test('runtime readiness verifies the staged manifest hash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twinscript-runtime-'));
  const executable = path.join(root, 'twinscript-local-inference.exe');
  const bytes = Buffer.from('verified runtime');
  fs.writeFileSync(executable, bytes);
  fs.writeFileSync(path.join(root, 'runtime-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    files: [{
      path: 'twinscript-local-inference.exe',
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    }],
  }));

  assert.equal(verifyRuntimeManifest(executable), true);
  fs.appendFileSync(executable, '!');
  assert.equal(verifyRuntimeManifest(executable), false);
});

test('packaged model readiness requires a verification marker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twinscript-model-'));
  const model = path.join(root, 'model.bin');
  fs.writeFileSync(model, 'weights');

  assert.equal(hasVerifiedMarker(model, ['model.bin']), false);
  fs.writeFileSync(path.join(root, '.verified.json'), JSON.stringify({
    version: path.basename(root),
    files: { 'model.bin': 'a'.repeat(64) },
  }));
  assert.equal(hasVerifiedMarker(model, ['model.bin']), true);
});
