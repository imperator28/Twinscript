const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EncryptedAudioWriter } = require('./encrypted-audio-writer');
const {
  CHANNEL_FILENAMES,
  alignChannelSamples,
  finalizeChannelSamples,
  finalizeSessionAudio,
  readAuthenticatedChunks,
  writeWavFile,
} = require('./wav-finalizer');

const KEY = crypto.randomBytes(32);
const SAMPLE_RATE = 24000;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wav-finalizer-'));
}

async function writeChunks(filePath, sessionId, channel, chunks) {
  const writer = new EncryptedAudioWriter({ filePath, key: KEY, sessionId, channel });
  for (const { samples, capturedAt } of chunks) {
    writer.write(Int16Array.from(samples), capturedAt, 0);
  }
  await writer.finish();
}

function readWavSamples(filePath) {
  const buffer = fs.readFileSync(filePath);
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  const dataBytes = buffer.readUInt32LE(40);
  const data = buffer.subarray(44, 44 + dataBytes);
  return new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2);
}

test('alignChannelSamples inserts silence for a leading offset', () => {
  const chunks = [{ capturedAt: 1000, samples: Int16Array.from([5, 5, 5]) }];
  // epoch 0, capturedAt 1000ms in -> 24 samples of silence at 24000Hz/1000
  const result = alignChannelSamples(chunks, 900, SAMPLE_RATE / 240);
  // sampleRate chosen small (100Hz) so the math is easy to check by hand:
  // offset = (1000-900)/1000 * 100 = 10 samples of silence.
  assert.equal(result.length, 13);
  assert.deepEqual(Array.from(result.subarray(0, 10)), new Array(10).fill(0));
  assert.deepEqual(Array.from(result.subarray(10)), [5, 5, 5]);
});

test('alignChannelSamples fills a mid-stream gap with silence', () => {
  const chunks = [
    { capturedAt: 0, samples: Int16Array.from([1, 1]) },
    // 100 samples at 100Hz would be 1000ms later; this chunk arrives 2000ms
    // later, leaving a 100-sample gap after the first 2 samples.
    { capturedAt: 2000, samples: Int16Array.from([2, 2]) },
  ];
  const result = alignChannelSamples(chunks, 0, 100);
  assert.equal(result.length, 2 + 198 + 2);
  assert.deepEqual(Array.from(result.subarray(0, 2)), [1, 1]);
  assert.deepEqual(Array.from(result.subarray(2, 200)), new Array(198).fill(0));
  assert.deepEqual(Array.from(result.subarray(200)), [2, 2]);
});

test('an empty channel produces an empty (not missing) result at the pure layer', () => {
  assert.equal(alignChannelSamples([], 0, SAMPLE_RATE).length, 0);
});

test('readAuthenticatedChunks tolerates a crash-truncated final line', async () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'microphone.bcr');
  await writeChunks(filePath, 's1', 'microphone', [
    { capturedAt: 0, samples: [1, 2, 3] },
    { capturedAt: 100, samples: [4, 5, 6] },
  ]);
  fs.appendFileSync(filePath, '{"version":1,"sessionId":"s1","channel":"micro');

  const { chunks, truncated } = readAuthenticatedChunks(filePath, KEY);
  assert.equal(truncated, true);
  assert.equal(chunks.length, 2);
  assert.deepEqual(Array.from(chunks[1].samples), [4, 5, 6]);
});

test('a missing .bcr file reads as zero chunks, not an error', () => {
  const dir = tempDir();
  const { chunks, truncated } = readAuthenticatedChunks(
    path.join(dir, 'absent.bcr'),
    KEY,
  );
  assert.deepEqual(chunks, []);
  assert.equal(truncated, false);
});

test('finalizeChannelSamples reports a channel with zero chunks as missing (null)', () => {
  const dir = tempDir();
  const result = finalizeChannelSamples({
    filePath: path.join(dir, 'system.bcr'),
    key: KEY,
    sampleRate: SAMPLE_RATE,
    epochMs: 0,
  });
  assert.equal(result, null);
});

test('writeWavFile produces a header ffmpeg/Audacity can read and round-trips samples', async () => {
  const dir = tempDir();
  const destPath = path.join(dir, 'microphone.wav');
  const samples = Int16Array.from([0, 100, -100, 32767, -32768, 1, 2, 3]);
  await writeWavFile(destPath, { sampleRate: SAMPLE_RATE, samples });

  assert.equal(fs.existsSync(`${destPath}.partial`), false);
  const buffer = fs.readFileSync(destPath);
  assert.equal(buffer.readUInt16LE(20), 1); // PCM format tag
  assert.equal(buffer.readUInt16LE(22), 1); // mono
  assert.equal(buffer.readUInt32LE(24), SAMPLE_RATE);
  assert.equal(buffer.readUInt16LE(34), 16); // bits per sample
  assert.deepEqual(Array.from(readWavSamples(destPath)), Array.from(samples));
});

test('finalizeSessionAudio writes microphone.wav and meeting-audio.wav with matching duration', async () => {
  const dir = tempDir();
  const micPath = path.join(dir, 'microphone.bcr');
  const sysPath = path.join(dir, 'meeting-audio.bcr');
  await writeChunks(micPath, 's1', 'microphone', [
    { capturedAt: 0, samples: new Array(100).fill(7) },
  ]);
  await writeChunks(sysPath, 's1', 'system', [
    { capturedAt: 0, samples: new Array(40).fill(9) },
  ]);
  const destDir = tempDir();

  const results = await finalizeSessionAudio({
    channels: {
      microphone: { filePath: micPath },
      system: { filePath: sysPath },
    },
    key: KEY,
    sampleRate: 100,
    epochMs: 0,
    destDir,
  });

  assert.equal(results.microphone.status, 'written');
  assert.equal(results.system.status, 'written');
  assert.equal(fs.existsSync(path.join(destDir, CHANNEL_FILENAMES.microphone)), true);
  assert.equal(fs.existsSync(path.join(destDir, CHANNEL_FILENAMES.system)), true);

  const mic = readWavSamples(path.join(destDir, CHANNEL_FILENAMES.microphone));
  const sys = readWavSamples(path.join(destDir, CHANNEL_FILENAMES.system));
  // Both tracks share the same duration even though system stopped earlier.
  assert.equal(mic.length, sys.length);
  assert.equal(mic.length, 100);
  assert.deepEqual(Array.from(sys.subarray(0, 40)), new Array(40).fill(9));
  assert.deepEqual(Array.from(sys.subarray(40)), new Array(60).fill(0));
});

test('a channel that never captured anything gets no WAV file at all', async () => {
  const dir = tempDir();
  const micPath = path.join(dir, 'microphone.bcr');
  await writeChunks(micPath, 's1', 'microphone', [
    { capturedAt: 0, samples: [1, 2, 3] },
  ]);
  const destDir = tempDir();

  const results = await finalizeSessionAudio({
    channels: {
      microphone: { filePath: micPath },
      // system.bcr was never created: loopback failed for the whole meeting.
      system: { filePath: path.join(dir, 'meeting-audio.bcr') },
    },
    key: KEY,
    sampleRate: SAMPLE_RATE,
    epochMs: 0,
    destDir,
  });

  assert.equal(results.microphone.status, 'written');
  assert.equal(results.system.status, 'missing');
  assert.equal(fs.existsSync(path.join(destDir, CHANNEL_FILENAMES.system)), false);
});

test('a write failure on one channel does not affect the other', async () => {
  const dir = tempDir();
  const micPath = path.join(dir, 'microphone.bcr');
  const sysPath = path.join(dir, 'meeting-audio.bcr');
  await writeChunks(micPath, 's1', 'microphone', [{ capturedAt: 0, samples: [1, 2] }]);
  await writeChunks(sysPath, 's1', 'system', [{ capturedAt: 0, samples: [3, 4] }]);
  // The finalizer writes to a sibling `.partial` file before renaming into
  // place; block exactly that path so the microphone write fails while system
  // still succeeds.
  const destDir = tempDir();
  fs.mkdirSync(path.join(destDir, `${CHANNEL_FILENAMES.microphone}.partial`));

  const results = await finalizeSessionAudio({
    channels: { microphone: { filePath: micPath }, system: { filePath: sysPath } },
    key: KEY,
    sampleRate: SAMPLE_RATE,
    epochMs: 0,
    destDir,
  });

  assert.equal(results.system.status, 'written');
  assert.equal(fs.existsSync(path.join(destDir, CHANNEL_FILENAMES.system)), true);
  assert.equal(results.microphone.status, 'failed');
});

test('a tampered chunk stops finalization at that point without throwing', async () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'microphone.bcr');
  await writeChunks(filePath, 's1', 'microphone', [
    { capturedAt: 0, samples: [1, 2, 3] },
    { capturedAt: 100, samples: [4, 5, 6] },
  ]);
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const tampered = JSON.parse(lines[1]);
  tampered.data = Buffer.from('garbage').toString('base64');
  fs.writeFileSync(filePath, `${lines[0]}\n${JSON.stringify(tampered)}\n`);

  const { chunks, truncated } = readAuthenticatedChunks(filePath, KEY);
  assert.equal(truncated, true);
  assert.equal(chunks.length, 1);
  assert.deepEqual(Array.from(chunks[0].samples), [1, 2, 3]);
});
