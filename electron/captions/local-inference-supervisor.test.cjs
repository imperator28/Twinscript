const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  LocalInferenceSupervisor,
  resolveLocalInferenceExecutable,
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
