const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

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

test('hybrid client keeps listeners and routes requests after native host replacement', async () => {
  const first = new EventEmitter();
  first.request = async () => ({ host: 'first' });
  first.dispose = () => {};
  const second = new EventEmitter();
  second.request = async () => ({ host: 'second' });
  second.dispose = () => {};
  const events = [];
  const client = new HybridLocalInferenceClient({ base: first });
  client.on('event', (event) => events.push(event.host));

  client.replaceBase(second);
  first.emit('event', { host: 'stale' });
  second.emit('event', { host: 'second' });

  assert.equal((await client.request('health')).host, 'second');
  assert.deepEqual(events, ['second']);
});
