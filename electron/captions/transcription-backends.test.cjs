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

test('local Whisper drops punctuation-only decoder hallucinations', () => {
  const events = [];
  const backend = new LocalWhisperBackend({
    client: { request: async () => ({}) },
    channel: 'microphone',
    sessionId: 's1',
    onEvent: (event) => events.push(event),
  });

  assert.equal(backend.accept({
    type: 'asr.result',
    channel: 'microphone',
    utteranceId: 'u-noise',
    text: ' , … ',
    final: true,
  }), false);
  assert.deepEqual(events, []);
});

test('local Whisper drops runaway repeated-word decoder hallucinations', () => {
  const events = [];
  const backend = new LocalWhisperBackend({
    client: { request: async () => ({}) },
    channel: 'microphone',
    sessionId: 's1',
    onEvent: (event) => events.push(event),
  });

  assert.equal(backend.accept({
    type: 'asr.result',
    channel: 'microphone',
    utteranceId: 'u-repeat',
    text: Array(30).fill('quickly').join(', '),
    final: true,
  }), false);
  assert.equal(backend.accept({
    type: 'asr.result',
    channel: 'microphone',
    utteranceId: 'u-repeat-phrase',
    text: Array(20).fill('even more').join(', '),
    final: true,
  }), false);
  assert.deepEqual(events, []);
});

test('local Whisper preserves ordinary text that repeats a meaningful word', () => {
  const events = [];
  const backend = new LocalWhisperBackend({
    client: { request: async () => ({}) },
    channel: 'microphone',
    sessionId: 's1',
    onEvent: (event) => events.push(event),
  });

  assert.equal(backend.accept({
    type: 'asr.result',
    channel: 'microphone',
    utteranceId: 'u-normal',
    text: 'Move quickly, but verify the result quickly before the next test.',
    final: true,
  }), true);
  assert.equal(events[0].transcript, 'Move quickly, but verify the result quickly before the next test.');
});

test('local Whisper namespaces utterance IDs by native host generation', () => {
  const events = [];
  const backend = new LocalWhisperBackend({
    client: { request: async () => ({}) },
    channel: 'microphone',
    sessionId: 's1',
    onEvent: (event) => events.push(event),
  });

  backend.accept({
    type: 'asr.result', channel: 'microphone', utteranceId: 's1:microphone:1',
    generation: 1, text: 'before restart', final: true,
  });
  backend.accept({
    type: 'asr.result', channel: 'microphone', utteranceId: 's1:microphone:1',
    generation: 2, text: 'after restart', final: true,
  });

  assert.notEqual(events[0].itemId, events[1].itemId);
});

test('local Whisper forwards the existing 24 kHz PCM audio contract', async () => {
  const calls = [];
  const backend = new LocalWhisperBackend({
    client: { request: async (type, payload) => { calls.push([type, payload]); return {}; } },
    channel: 'system',
    sessionId: 's1',
  });

  backend.appendAudio(new Int16Array([1000, -2000, 3000]), 1234);
  await backend.drain();

  assert.equal(calls[0][0], 'asr.audio');
  assert.equal(calls[0][1].sampleRate, 24000);
  assert.equal(calls[0][1].encoding, 'pcm_s16le');
  assert.equal(calls[0][1].channel, 'system');
  assert.equal(calls[0][1].capturedAt, 1234);
  assert.equal(Buffer.from(calls[0][1].audio, 'base64').length, 6);
});

test('local Whisper keeps sub-floor background noise out of the inference worker', async () => {
  const calls = [];
  const events = [];
  const backend = new LocalWhisperBackend({
    client: {
      request: async (type) => {
        calls.push(type);
        return {};
      },
    },
    channel: 'microphone',
    sessionId: 's1',
    settings: { vadEnabled: false, vadThreshold: 0.012 },
    onEvent: (event) => events.push(event),
  });

  backend.appendAudio(new Int16Array(2400).fill(100));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, []);
  assert.deepEqual(
    events.find((event) => event.type === 'level'),
    {
      type: 'level',
      channel: 'microphone',
      rms: 100 / 32768,
      speaking: false,
    },
  );
});

test('local Whisper reports audio handed to the inference worker', async () => {
  const events = [];
  let resolveAudio;
  const backend = new LocalWhisperBackend({
    client: {
      request: () => new Promise((resolve) => { resolveAudio = resolve; }),
    },
    channel: 'microphone',
    sessionId: 's1',
    onEvent: (event) => events.push(event),
  });

  backend.appendAudio(new Int16Array(2400).fill(1000));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    events.find((event) => event.type === 'transport-metric'),
    {
      type: 'transport-metric',
      channel: 'microphone',
      sentAudioMs: 100,
      droppedAudioMs: 0,
      pendingChunks: 0,
      bufferedBytes: 0,
    },
  );

  resolveAudio({});
  await backend.drain();
});

test('local Whisper serializes audio requests and keeps backlog bounded', async () => {
  let releaseFirst;
  let calls = 0;
  const errors = [];
  const client = {
    request: async () => {
      calls += 1;
      if (calls === 1) await new Promise((resolve) => { releaseFirst = resolve; });
      return {};
    },
  };
  const backend = new LocalWhisperBackend({
    client,
    channel: 'microphone',
    sessionId: 's1',
    onEvent: (event) => errors.push(event),
  });

  for (let index = 0; index < 20; ++index) {
    backend.appendAudio(new Int16Array(24000).fill((index + 1) * 1000), index);
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 1, 'only one audio request may be in flight');
  assert.ok(backend.queuedSamples <= 240000, 'backlog stays at or below ten seconds');
  assert.ok(errors.some((event) => event.code === 'local_asr_backpressure_dropped'));

  releaseFirst();
  await backend.drain();
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

test('local Whisper finish aborts a hung audio request and drops queued chunks', async () => {
  const events = [];
  const client = {
    request: (type, _payload, { signal } = {}) => {
      if (type !== 'asr.audio') return Promise.resolve({});
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(
          Object.assign(new Error('aborted'), { code: 'local_request_aborted' }),
        ), { once: true });
      });
    },
    on() {}, off() {},
  };
  const backend = new LocalWhisperBackend({
    client,
    channel: 'microphone',
    sessionId: 's1',
    finishTimeoutMs: 15,
    onEvent: (event) => events.push(event),
  });
  for (let index = 0; index < 10; ++index) {
    backend.appendAudio(new Int16Array(2400).fill((index + 1) * 1000));
  }

  await backend.finish();

  assert.equal(backend.audioQueue.length, 0);
  assert.equal(backend.queuedSamples, 0);
  assert.ok(events.some((event) => event.code === 'local_asr_shutdown_timeout'));
});
