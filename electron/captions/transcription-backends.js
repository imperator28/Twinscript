const { LiveTranscriptionSession } = require('./live-transcription-session');

const MAX_AUDIO_SAMPLES = 240000;
const MAX_QUEUED_AUDIO_SAMPLES = 240000;

class LocalWhisperBackend {
  constructor({
    client,
    channel,
    sessionId,
    onEvent = () => {},
    onUsage = () => {},
  }) {
    this.client = client;
    this.channel = channel;
    this.sessionId = sessionId;
    this.onEvent = onEvent;
    this.onUsage = onUsage;
    this.audioQueue = [];
    this.queuedSamples = 0;
    this.audioDrainPromise = null;
    this.onClientEvent = (message) => this.accept(message);
    client.on?.('event', this.onClientEvent);
  }

  async connect() {
    await this.client.request('asr.start', {
      sessionId: this.sessionId,
      channel: this.channel,
    });
    this.onEvent({ type: 'connection', channel: this.channel, status: 'connected' });
  }

  appendAudio(samples, capturedAt = Date.now()) {
    const pcm = samples instanceof Int16Array
      ? samples
      : new Int16Array(samples.buffer, samples.byteOffset, samples.byteLength / 2);
    for (let offset = 0; offset < pcm.length; offset += MAX_AUDIO_SAMPLES) {
      const chunk = pcm.subarray(offset, Math.min(pcm.length, offset + MAX_AUDIO_SAMPLES));
      const samplesCopy = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      this.audioQueue.push({ samples: samplesCopy, sampleCount: chunk.length, capturedAt });
      this.queuedSamples += chunk.length;
      let droppedSamples = 0;
      while (this.queuedSamples > MAX_QUEUED_AUDIO_SAMPLES && this.audioQueue.length > 1) {
        const dropped = this.audioQueue.shift();
        this.queuedSamples -= dropped.sampleCount;
        droppedSamples += dropped.sampleCount;
      }
      if (droppedSamples > 0) {
        this.onUsage({ droppedAudioMs: (droppedSamples / 24000) * 1000 });
        this.onEvent({
          type: 'error',
          channel: this.channel,
          code: 'local_asr_backpressure_dropped',
          message: 'Local transcription fell behind and dropped the oldest queued audio',
        });
      }
      this.onUsage({ audioMs: (chunk.length / 24000) * 1000 });
    }
    this.pumpAudio();
  }

  pumpAudio() {
    if (this.audioDrainPromise) return this.audioDrainPromise;
    this.audioDrainPromise = (async () => {
      while (this.audioQueue.length > 0) {
        const chunk = this.audioQueue.shift();
        this.queuedSamples -= chunk.sampleCount;
        try {
          const message = await this.client.request('asr.audio', {
            sessionId: this.sessionId,
            channel: this.channel,
            encoding: 'pcm_s16le',
            sampleRate: 24000,
            capturedAt: chunk.capturedAt,
            audio: chunk.samples.toString('base64'),
          });
          this.accept(message);
        } catch (error) {
          this.onEvent({
            type: 'error',
            channel: this.channel,
            code: error.code || 'local_asr_failed',
            message: error.message,
          });
        }
      }
    })().finally(() => {
      this.audioDrainPromise = null;
      if (this.audioQueue.length > 0) this.pumpAudio();
    });
    return this.audioDrainPromise;
  }

  accept(message) {
    if (message?.type !== 'asr.result' || message.channel !== this.channel) return false;
    this.onEvent({
      type: 'transcript',
      channel: this.channel,
      itemId: message.utteranceId,
      transcript: message.text,
      final: message.final === true,
      startedAt: message.startedAt,
      at: message.capturedAt,
      runtime: message.runtime || 'openvino-genai',
      model: message.model || 'whisper-small',
      actualDevice: message.actualDevice,
      inferenceMs: message.inferenceMs,
    });
    return true;
  }

  async drain() {
    while (this.audioDrainPromise) await this.audioDrainPromise;
  }

  async finish() {
    await this.drain();
    try {
      const message = await this.client.request('asr.flush', {
        sessionId: this.sessionId,
        channel: this.channel,
      });
      this.accept(message);
    } finally {
      await this.close();
    }
  }

  async close() {
    try {
      await this.client.request('asr.stop', {
        sessionId: this.sessionId,
        channel: this.channel,
      });
    } finally {
      this.client.off?.('event', this.onClientEvent);
    }
  }
}

class TranscriptionBackendFactory {
  constructor({ CloudSession = LiveTranscriptionSession } = {}) {
    this.CloudSession = CloudSession;
  }

  create(model, options) {
    if (model === 'whisper-local') return new LocalWhisperBackend(options);
    if (model === 'openai-live') return new this.CloudSession(options);
    const error = new Error(`Unsupported transcription model: ${model}`);
    error.code = 'unsupported_transcription_model';
    throw error;
  }
}

module.exports = {
  MAX_QUEUED_AUDIO_SAMPLES,
  LocalWhisperBackend,
  TranscriptionBackendFactory,
};
