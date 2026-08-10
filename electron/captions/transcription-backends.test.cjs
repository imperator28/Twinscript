const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LocalWhisperBackend,
  TranscriptionBackendFactory,
} = require('./transcription-backends');


test('local Whisper maps protocol output to the existing transcript event', () => {
  const events = [];
  const backend = new LocalWhisperBackend({
    client: { request: async () => ({}) },
    channel: 'microphone',
    sessionId: 's1',
    onEvent: (event) => events.push(event),
  });
  backend.accept({
    type: 'asr.result',
    channel: 'microphone',
    utteranceId: 'u1',
    text: 'Hello',
    final: true,
    actualDevice: 'NPU',
    inferenceMs: 200,
  });

  assert.deepEqual(events[0], {
    type: 'transcript',
    channel: 'microphone',
    itemId: 'u1',
    transcript: 'Hello',
    final: true,
    startedAt: undefined,
    at: undefined,
    runtime: 'openvino-genai',
    model: 'whisper-small',
    actualDevice: 'NPU',
    inferenceMs: 200,
  });
});

test('local Whisper forwards the existing 24 kHz PCM audio contract', async () => {
  const calls = [];
  const backend = new LocalWhisperBackend({
    client: { request: async (type, payload) => { calls.push([type, payload]); return {}; } },
    channel: 'system',
    sessionId: 's1',
  });

  backend.appendAudio(new Int16Array([1, -2, 3]), 1234);
  await backend.drain();

  assert.equal(calls[0][0], 'asr.audio');
  assert.equal(calls[0][1].sampleRate, 24000);
  assert.equal(calls[0][1].encoding, 'pcm_s16le');
  assert.equal(calls[0][1].channel, 'system');
  assert.equal(calls[0][1].capturedAt, 1234);
  assert.equal(Buffer.from(calls[0][1].audio, 'base64').length, 6);
});

test('transcription factory preserves the existing cloud class', () => {
  class CloudSession {}
  const factory = new TranscriptionBackendFactory({ CloudSession });

  assert.ok(factory.create('openai-live', {}) instanceof CloudSession);
});

test('local Whisper finish flushes, stops the channel, and detaches its listener', async () => {
  const calls = [];
  const listener = {};
  const client = {
    request: async (type) => { calls.push(type); return {}; },
    on: (type, callback) => { listener[type] = callback; },
    off: (type, callback) => {
      calls.push(`off:${type}:${callback === listener[type]}`);
    },
  };
  const backend = new LocalWhisperBackend({
    client,
    channel: 'microphone',
    sessionId: 's1',
  });

  await backend.finish();

  assert.deepEqual(calls, ['asr.flush', 'asr.stop', 'off:event:true']);
});
