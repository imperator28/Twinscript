const crypto = require('crypto');
const fs = require('fs');

const FORMAT_VERSION = 1;

// One bounded, encrypted backup stream for one audio channel of one meeting.
//
// A session holds two of these (microphone, system). Each PCM chunk handed to
// `write()` is encrypted independently — never buffered as plaintext beyond
// the synchronous encrypt call — and appended as one authenticated JSONL line
// to an app-owned `.bcr` file. Backup persistence must never slow down or
// interrupt the live transcription path that the same chunk was also sent to,
// so the queue is bounded: once `maxQueuedChunks` chunks are waiting on disk
// I/O, further chunks are dropped and their duration is reported rather than
// growing an unbounded memory queue.

const DEFAULT_MAX_QUEUED_CHUNKS = 64;

function encryptChunk({ key, sessionId, channel, sequence, capturedAt, pcm }) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const aad = Buffer.from(
    `${FORMAT_VERSION}:${sessionId}:${channel}:${sequence}:${capturedAt}`,
  );
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)),
    cipher.final(),
  ]);
  return `${JSON.stringify({
    version: FORMAT_VERSION,
    sessionId,
    channel,
    sequence,
    capturedAt,
    sampleCount: pcm.length,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  })}\n`;
}

/**
 * Decrypt one JSONL line produced by `encryptChunk`/`EncryptedAudioWriter`.
 *
 * Shared with the WAV finalizer so both sides of the format agree on framing.
 * Throws on a JSON-parse failure, an auth-tag mismatch, or a tampered/corrupt
 * chunk — callers decide whether that means "stop, the tail is a crash
 * artifact" or "reject the whole file".
 */
function decryptChunkLine(line, key) {
  const record = JSON.parse(line);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(record.iv, 'base64'),
  );
  decipher.setAAD(
    Buffer.from(
      `${record.version}:${record.sessionId}:${record.channel}:${record.sequence}:${record.capturedAt}`,
    ),
  );
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.data, 'base64')),
    decipher.final(),
  ]);
  const samples = new Int16Array(
    plaintext.buffer,
    plaintext.byteOffset,
    plaintext.byteLength / 2,
  );
  return {
    channel: record.channel,
    sequence: record.sequence,
    capturedAt: record.capturedAt,
    sampleCount: record.sampleCount,
    samples,
  };
}

class EncryptedAudioWriter {
  constructor({
    filePath,
    key,
    sessionId,
    channel,
    maxQueuedChunks = DEFAULT_MAX_QUEUED_CHUNKS,
    onState,
    appendFileImpl = fs.promises.appendFile,
  }) {
    this.filePath = filePath;
    this.key = key;
    this.sessionId = sessionId;
    this.channel = channel;
    this.maxQueuedChunks = maxQueuedChunks;
    this.onState = onState || (() => {});
    this.appendFileImpl = appendFileImpl;
    this.queue = Promise.resolve();
    this.queuedCount = 0;
    this.sequence = 0;
    this.chunkCount = 0;
    this.droppedChunks = 0;
    this.droppedMs = 0;
    this.firstCapturedAt = null;
    this.lastCapturedAt = null;
    this.state = 'healthy';
    this.lastError = null;
  }

  setState(state, extra = {}) {
    if (this.state === state && !Object.keys(extra).length) return;
    this.state = state;
    this.onState({
      channel: this.channel,
      state,
      droppedMs: this.droppedMs,
      ...extra,
    });
  }

  /**
   * Encrypt and enqueue one PCM chunk. Never throws: a failure degrades the
   * channel's backup state and is reported through `onState`, but the caller's
   * transcription path is unaffected.
   *
   * `durationMs` is the chunk's playback duration, used only to account for
   * dropped backup coverage when the queue is saturated.
   */
  write(pcm, capturedAt, durationMs) {
    if (this.state === 'failed') return;
    if (this.queuedCount >= this.maxQueuedChunks) {
      this.droppedChunks += 1;
      this.droppedMs += durationMs || 0;
      this.setState('degraded', { reason: 'queue_saturated' });
      return;
    }

    let line;
    try {
      this.sequence += 1;
      line = encryptChunk({
        key: this.key,
        sessionId: this.sessionId,
        channel: this.channel,
        sequence: this.sequence,
        capturedAt,
        pcm,
      });
    } catch (error) {
      this.setState('failed', { error: error.message });
      return;
    }

    if (this.firstCapturedAt === null) this.firstCapturedAt = capturedAt;
    this.lastCapturedAt = capturedAt;
    this.queuedCount += 1;
    this.queue = this.queue
      .then(
        () =>
          this.appendFileImpl(this.filePath, line, {
            encoding: 'utf8',
            mode: 0o600,
          }),
        // A prior chunk in this chain already failed; do not attempt to write
        // this one to a file whose stream position is now unknown.
        () => {},
      )
      .then(() => {
        this.chunkCount += 1;
      })
      .catch((error) => {
        this.lastError = error.message;
        this.setState('failed', { error: error.message });
      })
      .finally(() => {
        this.queuedCount -= 1;
        // Queue saturation is a transient, self-healing condition: once the
        // backlog drains with no write failure, backup is caught up again. A
        // hard write failure is not auto-cleared — it is reported as `failed`
        // and stays that way for the rest of the session.
        if (this.state === 'degraded' && this.queuedCount === 0 && !this.lastError) {
          this.setState('healthy');
        }
      });
  }

  /** Drain the write queue and return final stats for this channel. */
  async finish() {
    await this.queue;
    return {
      channel: this.channel,
      chunkCount: this.chunkCount,
      droppedChunks: this.droppedChunks,
      droppedMs: this.droppedMs,
      firstCapturedAt: this.firstCapturedAt,
      lastCapturedAt: this.lastCapturedAt,
      state: this.state,
      error: this.lastError,
    };
  }
}

module.exports = {
  EncryptedAudioWriter,
  FORMAT_VERSION,
  DEFAULT_MAX_QUEUED_CHUNKS,
  decryptChunkLine,
};
