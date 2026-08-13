const { LiveTranscriptionSession } = require('./live-transcription-session');

const MAX_AUDIO_SAMPLES = 240000;
const MAX_QUEUED_AUDIO_SAMPLES = 240000;

function waitForAbort(signal) {
  if (signal.aborted) return Promise.reject(signal.reason || new Error('Aborted'));
  return new Promise((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(signal.reason || new Error('Aborted')),
      { once: true },
    );
  });
}

class LocalWhisperBackend {
  constructor({
    client,
    channel,
    sessionId,
    onEvent = () => {},
    onUsage = () => {},
    finishTimeoutMs = 5_000,
  }) {
    this.client = client;
    this.channel = channel;
    this.sessionId = sessionId;
    this.onEvent = onEvent;
    this.onUsage = onUsage;
    this.finishTimeoutMs = finishTimeoutMs;
    this.audioQueue = [];
    this.queuedSamples = 0;
    this.audioDrainPromise = null;
    this.currentAudioController = null;
    this.acceptingAudio = true;
    this.sentAudioMs = 0;
    this.droppedAudioMs = 0;
    this.onClientEvent = (message) => this.accept(message);
    client.on?.('event', this.onClientEvent);
  }

  emitTransportMetric() {
    this.onEvent({
      type: 'transport-metric',
      channel: this.channel,
      sentAudioMs: this.sentAudioMs,
      droppedAudioMs: this.droppedAudioMs,
      pendingChunks: this.audioQueue.length,
      bufferedBytes: this.queuedSamples * Int16Array.BYTES_PER_ELEMENT,
    });
  }

  async connect() {
    await this.client.request('asr.start', {
      sessionId: this.sessionId,
      channel: this.channel,
    });
    this.onEvent({ type: 'connection', channel: this.channel, status: 'connected' });
  }

  appendAudio(samples, capturedAt = Date.now()) {
    if (!this.acceptingAudio) return;
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
        const droppedAudioMs = (droppedSamples / 24000) * 1000;
        this.droppedAudioMs += droppedAudioMs;
        this.onUsage({ droppedAudioMs });
        this.emitTransportMetric();
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
        const requestController = new AbortController();
        this.currentAudioController = requestController;
        try {
          const request = this.client.request('asr.audio', {
            sessionId: this.sessionId,
            channel: this.channel,
            encoding: 'pcm_s16le',
            sampleRate: 24000,
            capturedAt: chunk.capturedAt,
            audio: chunk.samples.toString('base64'),
          }, { signal: requestController.signal });
          this.sentAudioMs += (chunk.sampleCount / 24000) * 1000;
          this.emitTransportMetric();
          const message = await request;
          this.accept(message);
        } catch (error) {
          this.onEvent({
            type: 'error',
            channel: this.channel,
            code: error.code || 'local_asr_failed',
            message: error.message,
          });
        } finally {
          if (this.currentAudioController === requestController) {
            this.currentAudioController = null;
          }
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
      itemId: Number.isSafeInteger(message.generation)
        ? `${message.utteranceId}:host-${message.generation}`
        : message.utteranceId,
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

  cancelPending() {
    this.acceptingAudio = false;
    this.audioQueue = [];
    this.queuedSamples = 0;
    this.currentAudioController?.abort();
  }

  async finish() {
    this.acceptingAudio = false;
    const finishController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.cancelPending();
      finishController.abort(new Error('Local transcription shutdown timed out'));
      this.onEvent({
        type: 'error',
        channel: this.channel,
        code: 'local_asr_shutdown_timeout',
        message: 'Local transcription did not drain before the shutdown timeout',
      });
    }, this.finishTimeoutMs);
    timer.unref?.();
    try {
      await Promise.race([this.drain(), waitForAbort(finishController.signal)]);
      if (!finishController.signal.aborted) {
        const request = this.client.request('asr.flush', {
          sessionId: this.sessionId,
          channel: this.channel,
        }, { signal: finishController.signal });
        const message = await Promise.race([request, waitForAbort(finishController.signal)]);
        this.accept(message);
      }
    } catch (error) {
      if (!timedOut) throw error;
    } finally {
      try {
        await this.close({ signal: finishController.signal });
      } catch (error) {
        if (!timedOut) throw error;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async close({ signal } = {}) {
    this.acceptingAudio = false;
    try {
      await this.client.request('asr.stop', {
        sessionId: this.sessionId,
        channel: this.channel,
      }, { signal });
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
