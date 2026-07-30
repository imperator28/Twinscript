const WebSocket = require('ws');
const { VadGate } = require('./vad-gate');

// A dedicated transcription connection is selected by intent. A `model`
// query parameter pre-creates a realtime conversation session, which cannot
// then be converted to a transcription session.
const TRANSCRIPTION_URL =
  'wss://api.openai.com/v1/realtime?intent=transcription';

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
    this.rejectConnect = null;
    this.vad = new VadGate({
      // gpt-live-transcribe currently requires explicit turn commits. Keep a
      // conservative detector active for segmentation even when the advanced
      // user-adjustable gate is disabled; in that mode it must never inherit a
      // threshold that can discard ordinary, quieter speech.
      enabled: true,
      threshold: settings.vadEnabled
        ? settings.vadThreshold
        : Math.min(settings.vadThreshold || 0.006, 0.006),
      preRollMs: 300,
      postRollMs: 650,
    });
    this.turnAudioMs = 0;
  }

  async connect() {
    this.closedByUser = false;
    await new Promise((resolve, reject) => {
      let settled = false;
      const socket = this.websocketFactory(TRANSCRIPTION_URL, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      this.socket = socket;

      const settle = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.rejectConnect = null;
        if (error) reject(error);
        else resolve();
      };
      this.rejectConnect = (error) =>
        settle(error || new Error(`${this.channel} transcription connection closed`));
      const timeout = setTimeout(() => {
        settle(new Error(`${this.channel} transcription connection timed out`));
        socket.close();
      }, 12000);

      socket.once('open', () => {
        socket.send(
          JSON.stringify({
            type: 'session.update',
            event_id: `caption-config-${this.channel}`,
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
                  turn_detection: null,
                },
              },
            },
          }),
        );
      });

      socket.on('message', (payload) => {
        const event = this.handleMessage(payload);
        if (event?.type === 'session.updated' && !settled) {
          this.connected = true;
          this.reconnectAttempts = 0;
          for (const pending of this.pendingChunks.splice(0)) {
            this.sendPcm(pending);
          }
          this.onEvent({
            type: 'connection',
            channel: this.channel,
            status: 'connected',
            at: Date.now(),
          });
          settle();
        }
        if (event?.type === 'error' && !settled) {
          const message =
            event.error?.message || 'OpenAI rejected the transcription session';
          const error = new Error(message);
          error.code = event.error?.code || 'transcription_session_rejected';
          settle(error);
          socket.close();
        }
      });
      socket.once('error', (error) => {
        if (!this.connected) settle(error);
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
        if (!settled) {
          settle(new Error(`${this.channel} transcription connection closed`));
        }
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
    if (gated.ended) this.commitAudioTurn();
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
    this.turnAudioMs += audioMs;
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

  commitAudioTurn() {
    if (
      this.turnAudioMs < 100 ||
      !this.connected ||
      this.socket?.readyState !== WebSocket.OPEN
    ) {
      this.turnAudioMs = 0;
      return;
    }
    this.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    this.turnAudioMs = 0;
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
      return null;
    }

    if (event.type === 'input_audio_buffer.speech_started') {
      if (event.item_id) this.startedAtByItem.set(event.item_id, Date.now());
      return event;
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
      return event;
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
      return event;
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
    return event;
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
    this.rejectConnect?.(
      new Error(`${this.channel} transcription connection cancelled`),
    );
    this.rejectConnect = null;
    this.vad.reset();
    this.turnAudioMs = 0;
    this.pendingChunks = [];
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) {
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
