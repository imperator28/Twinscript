const test = require('node:test');
const assert = require('node:assert/strict');

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
