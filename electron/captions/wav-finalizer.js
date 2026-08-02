const fs = require('fs');
const path = require('path');
const { decryptChunkLine } = require('./encrypted-audio-writer');

// Turns one channel's encrypted `.bcr` chunk stream into a playable WAV file,
// and aligns the microphone and meeting-audio channels onto one shared
// timeline so they stay in sync when reviewed side by side.
//
// A channel that produced zero chunks (the whole session, not merely a gap in
// it) is reported as "missing" rather than a fabricated silent WAV — Windows
// loopback can fail for the entire meeting, and a silent `meeting-audio.wav`
// would misrepresent that as "nothing was said" rather than "not captured".

const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2; // 16-bit PCM

const CHANNEL_FILENAMES = Object.freeze({
  microphone: 'microphone.wav',
  system: 'meeting-audio.wav',
});

/**
 * Read and decrypt every valid chunk in a `.bcr` file, in the order they
 * appear.
 *
 * Tolerant of a truncated or corrupt final line — an app crash mid-write
 * leaves a partial JSON line or an unauthenticatable tail chunk, and that must
 * not take down finalization of everything captured before it. A corrupt line
 * that is *not* the last one is unexpected (the writer only ever appends), and
 * is treated the same way: stop there, keep everything decrypted so far. The
 * source `.bcr` file itself is never modified, so a failed finalization can
 * always be retried.
 */
function readAuthenticatedChunks(filePath, key) {
  if (!fs.existsSync(filePath)) return { chunks: [], truncated: false };
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const chunks = [];
  let truncated = false;
  for (const line of lines) {
    try {
      chunks.push(decryptChunkLine(line, key));
    } catch {
      truncated = true;
      break;
    }
  }
  chunks.sort((left, right) => left.sequence - right.sequence);
  return { chunks, truncated };
}

/**
 * Lay out one channel's chunks on a shared timeline, in samples since
 * `epochMs`, inserting silence for any gap between chunks (or before the
 * first one) rather than concatenating chunks back to back.
 *
 * Without this, a channel that briefly drops out — or two channels whose
 * first chunk arrived at different wall-clock times — would drift out of sync
 * with anything they are compared against.
 */
function alignChannelSamples(chunks, epochMs, sampleRate) {
  if (!chunks.length) return new Int16Array(0);
  const parts = [];
  let cursor = 0;
  for (const chunk of chunks) {
    const expectedIndex = Math.round(
      ((chunk.capturedAt - epochMs) / 1000) * sampleRate,
    );
    if (expectedIndex > cursor) {
      parts.push(new Int16Array(expectedIndex - cursor));
      cursor = expectedIndex;
    }
    // A chunk that arrives "early" relative to the running cursor (clock
    // jitter, not a real overlap) is appended as-is rather than truncated —
    // dropping captured audio is worse than a few milliseconds of drift.
    parts.push(chunk.samples);
    cursor += chunk.samples.length;
  }
  const merged = new Int16Array(cursor);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

/**
 * Decrypt and align one channel's `.bcr` file. Returns `null` when the
 * channel produced no valid chunks at all — the "missing", not "silent", case.
 */
function finalizeChannelSamples({ filePath, key, sampleRate, epochMs }) {
  const { chunks } = readAuthenticatedChunks(filePath, key);
  if (!chunks.length) return null;
  return alignChannelSamples(chunks, epochMs, sampleRate);
}

function wavHeader({ sampleRate, dataBytes }) {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28); // byte rate
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/**
 * Write `samples` as a 16-bit mono PCM WAV file at `destPath`, atomically.
 *
 * The whole buffer is held in memory before writing — acceptable for this
 * client's target session lengths (a 60-minute channel at 24 kHz is under
 * 200 MB), but a future long-session hardening pass should stream chunk
 * decryption straight to disk instead of building one in-memory Int16Array.
 */
async function writeWavFile(destPath, { sampleRate, samples }) {
  const partialPath = `${destPath}.partial`;
  const dataBuffer = Buffer.from(
    samples.buffer,
    samples.byteOffset,
    samples.byteLength,
  );
  await new Promise((resolve, reject) => {
    // `stream.end(chunk, cb)`'s callback is not a reliable success signal: on
    // at least one platform it fires before a same-tick 'error' from a failed
    // open() reaches its listener, which would report a failed write as
    // successful. 'finish' is the documented, order-safe completion event —
    // it is never emitted once 'error' has fired.
    let settled = false;
    const stream = fs.createWriteStream(partialPath, { mode: 0o600 });
    const fail = (error) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(error);
    };
    stream.on('error', fail);
    stream.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    stream.write(
      wavHeader({ sampleRate, dataBytes: dataBuffer.byteLength }),
      (error) => {
        if (error) fail(error);
      },
    );
    stream.end(dataBuffer);
  });
  await fs.promises.rename(partialPath, destPath);
}

/**
 * Finalize both channels of one session into `microphone.wav` and
 * `meeting-audio.wav` inside `destDir`, sharing one timeline and duration.
 *
 * `channels` maps `microphone`/`system` to `{ filePath }` for that channel's
 * `.bcr` chunk stream. `epochMs` anchors sample 0 for both channels — pass the
 * earliest `firstCapturedAt` across whichever channels actually captured
 * anything.
 *
 * Returns one status per channel: `'written'`, `'missing'` (zero chunks —
 * no file created), or `'failed'` (an unexpected write error; the encrypted
 * source is untouched and finalization can be retried).
 */
async function finalizeSessionAudio({
  channels,
  key,
  sampleRate,
  epochMs,
  destDir,
}) {
  const aligned = {};
  for (const [channel, { filePath }] of Object.entries(channels)) {
    aligned[channel] = finalizeChannelSamples({
      filePath,
      key,
      sampleRate,
      epochMs,
    });
  }

  const available = Object.entries(aligned).filter(([, samples]) => samples);
  const maxLength = available.reduce(
    (max, [, samples]) => Math.max(max, samples.length),
    0,
  );

  const results = {};
  for (const [channel, samples] of Object.entries(aligned)) {
    const filename = CHANNEL_FILENAMES[channel];
    if (!filename) throw new Error(`Unknown audio channel: ${channel}`);
    if (!samples) {
      results[channel] = { status: 'missing' };
      continue;
    }
    // Both retained tracks share one duration so they stay aligned for
    // synchronized review, even if one channel stopped capturing earlier.
    const padded =
      samples.length < maxLength ? new Int16Array(maxLength) : samples;
    if (samples.length < maxLength) padded.set(samples, 0);
    try {
      await writeWavFile(path.join(destDir, filename), {
        sampleRate,
        samples: padded,
      });
      results[channel] = {
        status: 'written',
        sampleCount: padded.length,
        durationMs: Math.round((padded.length / sampleRate) * 1000),
      };
    } catch (error) {
      results[channel] = { status: 'failed', error: error.message };
    }
  }
  return results;
}

module.exports = {
  CHANNEL_FILENAMES,
  readAuthenticatedChunks,
  alignChannelSamples,
  finalizeChannelSamples,
  writeWavFile,
  finalizeSessionAudio,
};
