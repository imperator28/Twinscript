const WebSocket = require('ws');
const { VadGate } = require('./vad-gate');

const TRANSCRIPTION_URL =
  'wss://api.openai.com/v1/realtime?model=gpt-live-transcribe';

function sanitizeKeyword(value) {
  return String(value || '')
    .replace(/[<>\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

class LiveTranscriptionSession {
  constructor({
    channel,
    apiKey,
    settings,
    keywords = [],
    websocketFactory,
    onEvent = () => {},
    onUsage = () => {},
  }) {
    this.channel = channel;
    this.apiKey = apiKey;
    this.settings = settings;
    this.keywords = keywords.map(sanitizeKeyword).filter(Boolean).slice(0, 100);
    this.websocketFactory =
      websocketFactory ||
      ((url, options) => new WebSocket(url, options));
    this.onEvent = onEvent;
    this.onUsage = onUsage;
    this.socket = null;
    this.closedByUser = false;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.pendingChunks = [];
    this.maxPendingChunks = 20;
    this.maxSocketBufferedBytes = 512 * 1024;
    this.droppedAudioMs = 0;
    this.sentAudioMs = 0;
    this.reconnectTimer = null;
    this.partialByItem = new Map();
    this.startedAtByItem = new Map();
    this.vad = new VadGate({
      enabled: settings.vadEnabled,
      threshold: settings.vadThreshold,
    });
  }

  async connect() {
    this.closedByUser = false;
    await new Promise((resolve, reject) => {
      const socket = this.websocketFactory(TRANSCRIPTION_URL, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      this.socket = socket;

      const timeout = setTimeout(() => {
        reject(new Error(`${this.channel} transcription connection timed out`));
        socket.close();
      }, 12000);

      socket.once('open', () => {
        clearTimeout(timeout);
        this.connected = true;
        this.reconnectAttempts = 0;
        socket.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              type: 'transcription',
              audio: {
                input: {
                  format: { type: 'audio/pcm', rate: 24000 },
                  transcription: {
                    model: 'gpt-live-transcribe',
                    prompt:
                      'A bilingual English and Simplified Chinese engineering meeting about mechanical design, product design, manufacturing, dimensions, tolerances, materials, schedules, suppliers, part numbers, and tooling.',
                    keywords: this.keywords,
                    languages: ['en', 'zh-cn'],
                    delay: this.settings.delayProfile || 'low',
                  },
                  turn_detection: {
                    type: 'server_vad',
                    threshold: 0.45,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 550,
                  },
                },
              },
            },
          }),
        );
        for (const pending of this.pendingChunks.splice(0)) {
          this.sendPcm(pending);
        }
        this.onEvent({
          type: 'connection',
          channel: this.channel,
          status: 'connected',
          at: Date.now(),
        });
        resolve();
      });

      socket.on('message', (payload) => this.handleMessage(payload));
      socket.once('error', (error) => {
        clearTimeout(timeout);
        if (!this.connected) reject(error);
        this.onEvent({
          type: 'error',
          channel: this.channel,
          code: 'transcription_socket_error',
          message: error.message,
          at: Date.now(),
        });
      });
      socket.once('close', () => {
        this.connected = false;
        this.onEvent({
          type: 'connection',
          channel: this.channel,
          status: this.closedByUser ? 'closed' : 'disconnected',
          at: Date.now(),
        });
        if (!this.closedByUser) this.scheduleReconnect();
      });
    });
  }

  appendAudio(samples) {
    const int16 =
      samples instanceof Int16Array
        ? samples
        : new Int16Array(samples.buffer || samples);
    const durationMs = (int16.length / 24000) * 1000;
    const gated = this.vad.push(int16, durationMs);
    for (const chunk of gated.chunks) {
      if (this.connected && this.socket?.readyState === WebSocket.OPEN) {
        if ((this.socket.bufferedAmount || 0) <= this.maxSocketBufferedBytes) {
          this.sendPcm(chunk);
        } else {
          this.reportDrop(chunk, 'socket_backpressure');
        }
      } else if (this.pendingChunks.length < this.maxPendingChunks) {
        this.pendingChunks.push(chunk);
      } else {
        this.reportDrop(chunk, 'disconnected_queue_full');
      }
    }
    this.onEvent({
      type: 'level',
      channel: this.channel,
      rms: gated.rms,
      speaking: gated.speaking,
      at: Date.now(),
    });
  }

  sendPcm(samples) {
    this.socket.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: Buffer.from(
          samples.buffer,
          samples.byteOffset,
          samples.byteLength,
        ).toString('base64'),
      }),
    );
    const audioMs = (samples.length / 24000) * 1000;
    this.sentAudioMs += audioMs;
    this.onUsage({ audioMs });
    this.onEvent({
      type: 'transport-metric',
      channel: this.channel,
      sentAudioMs: this.sentAudioMs,
      droppedAudioMs: this.droppedAudioMs,
      pendingChunks: this.pendingChunks.length,
      bufferedBytes: this.socket?.bufferedAmount || 0,
      at: Date.now(),
    });
  }

  reportDrop(samples, reason) {
    const audioMs = (samples.length / 24000) * 1000;
    this.droppedAudioMs += audioMs;
    this.onEvent({
      type: 'transport-metric',
      channel: this.channel,
      sentAudioMs: this.sentAudioMs,
      droppedAudioMs: this.droppedAudioMs,
      droppedChunkMs: audioMs,
      dropReason: reason,
      pendingChunks: this.pendingChunks.length,
      bufferedBytes: this.socket?.bufferedAmount || 0,
      at: Date.now(),
    });
  }

  handleMessage(payload) {
    let event;
    try {
      event = JSON.parse(payload.toString());
    } catch {
      return;
    }

    if (event.type === 'input_audio_buffer.speech_started') {
      if (event.item_id) this.startedAtByItem.set(event.item_id, Date.now());
      return;
    }

    if (event.type === 'conversation.item.input_audio_transcription.delta') {
      const previous = this.partialByItem.get(event.item_id) || '';
      const transcript = previous + (event.delta || '');
      this.partialByItem.set(event.item_id, transcript);
      this.onEvent({
        type: 'transcript',
        channel: this.channel,
        itemId: event.item_id,
        transcript,
        final: false,
        startedAt: this.startedAtByItem.get(event.item_id) || Date.now(),
        at: Date.now(),
      });
      return;
    }

    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const transcript =
        event.transcript || this.partialByItem.get(event.item_id) || '';
      this.partialByItem.delete(event.item_id);
      this.onEvent({
        type: 'transcript',
        channel: this.channel,
        itemId: event.item_id,
        transcript,
        final: true,
        startedAt: this.startedAtByItem.get(event.item_id) || Date.now(),
        at: Date.now(),
      });
      this.startedAtByItem.delete(event.item_id);
      return;
    }

    if (event.type === 'error') {
      this.onEvent({
        type: 'error',
        channel: this.channel,
        code: event.error?.code || 'transcription_error',
        message: event.error?.message || 'Transcription failed',
        requestId: event.error?.event_id,
        at: Date.now(),
      });
    }
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= 5) {
      this.onEvent({
        type: 'error',
        channel: this.channel,
        code: 'transcription_reconnect_exhausted',
        message: 'Could not restore transcription after five attempts',
        at: Date.now(),
      });
      return;
    }
    const delay = Math.min(8000, 500 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this.connect().catch(() => {});
    }, delay);
  }

  close() {
    this.closedByUser = true;
    this.connected = false;
    this.vad.reset();
    this.pendingChunks = [];
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) {
      this.socket.removeAllListeners('close');
      this.socket.close();
      this.socket = null;
    }
  }
}

module.exports = {
  LiveTranscriptionSession,
  TRANSCRIPTION_URL,
  sanitizeKeyword,
};
