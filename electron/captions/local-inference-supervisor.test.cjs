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
  const translationServer = {
    start: async () => calls.push('translation:start'),
    translate: async () => ({ text: 'local' }),
    health: () => ({ id: 'hy-mt2-1.8b', actualDevice: 'CPU' }),
    stop: async () => calls.push('translation:stop'),
  };
  const supervisor = new LocalInferenceSupervisor({
    spawn: () => { throw new Error('unused'); },
    translationServer,
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
    'translation:start',
    ['model.prepare', []],
  ]);
});

test('readiness reports runtime and each local model independently', () => {
  const present = new Set(['host.exe', 'whisper', 'llama.exe']);
  const supervisor = new LocalInferenceSupervisor({
    executablePath: 'host.exe',
    whisperModelPath: 'whisper',
    llamaBinaryPath: 'llama.exe',
    hyMt2ModelPath: 'hy.gguf',
    exists: (candidate) => present.has(candidate),
    artifactReady: (kind, candidate) => kind === 'runtime'
      ? present.has(candidate)
      : kind === 'whisper-small'
        ? present.has(candidate)
        : present.has('llama.exe') && present.has(candidate),
  });

  assert.deepEqual(supervisor.readiness(), {
    runtimeReady: true,
    requestedDevice: 'NPU',
    models: {
      'whisper-small': { ready: true, actualDevice: null },
      'hy-mt2-1.8b': { ready: false, actualDevice: null },
    },
  });
});

test('packaged model readiness delegates to the lifecycle service', () => {
  const calls = [];
  const supervisor = new LocalInferenceSupervisor({
    isPackaged: true,
    executablePath: 'host.exe',
    whisperModelPath: 'whisper',
    hyMt2ModelPath: 'hy.gguf',
    modelReady: (modelId) => {
      calls.push(modelId);
      return modelId === 'whisper-small';
    },
    artifactReady: () => true,
  });

  const readiness = supervisor.readiness();

  assert.equal(readiness.models['whisper-small'].ready, true);
  assert.equal(readiness.models['hy-mt2-1.8b'].ready, false);
  assert.deepEqual(calls, ['whisper-small', 'hy-mt2-1.8b']);
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
