const assert = require('node:assert/strict');
const test = require('node:test');

const { HybridLocalInferenceClient } = require('./hybrid-local-inference-client');


test('hybrid client routes only translation operations to llama.cpp', async () => {
  const calls = [];
  const base = {
    request: async (type) => { calls.push(['native', type]); return { type: 'health' }; },
    on() {}, off() {}, dispose() {},
  };
  const translation = {
    translate: async (type) => { calls.push(['llama', type]); return { type: 'translate.result' }; },
    health: () => ({ ready: true }),
  };
  const client = new HybridLocalInferenceClient({ base, translation });

  await client.request('asr.start', { channel: 'microphone' });
  await client.request('translate.final', { text: 'hello' });

  assert.deepEqual(calls, [
    ['native', 'asr.start'],
    ['llama', 'translate.final'],
  ]);
});

test('hybrid hello and health expose both truthful runtimes', async () => {
  const client = new HybridLocalInferenceClient({
    base: {
      request: async (type) => type === 'hello'
        ? { protocolVersion: 1, type: 'capabilities', models: [{ id: 'whisper-small' }] }
        : { protocolVersion: 1, type: 'health', models: {} },
      on() {}, off() {}, dispose() {},
    },
    translation: {
      health: () => ({ id: 'hy-mt2-1.8b', runtime: 'llama.cpp-b9940', actualDevice: 'CPU' }),
    },
  });

  assert.equal((await client.request('hello')).models.length, 2);
  assert.equal((await client.request('health')).models['hy-mt2-1.8b'].actualDevice, 'CPU');
});
