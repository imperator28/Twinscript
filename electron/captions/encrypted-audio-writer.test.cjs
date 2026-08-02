const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  EncryptedAudioWriter,
  decryptChunkLine,
} = require('./encrypted-audio-writer');

const KEY = crypto.randomBytes(32);

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encrypted-audio-writer-'));
  return path.join(dir, 'channel.bcr');
}

function pcm(values) {
  return Int16Array.from(values);
}

function readLines(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean);
}

test('a written chunk decrypts back to the original samples', async () => {
  const filePath = tempFile();
  const writer = new EncryptedAudioWriter({
    filePath,
    key: KEY,
    sessionId: 'session-1',
    channel: 'microphone',
  });
  writer.write(pcm([1, -1, 32767, -32768, 0]), 1000, 100);
  const stats = await writer.finish();

  assert.equal(stats.chunkCount, 1);
  assert.equal(stats.state, 'healthy');
  const [line] = readLines(filePath);
  const decoded = decryptChunkLine(line, KEY);
  assert.deepEqual(Array.from(decoded.samples), [1, -1, 32767, -32768, 0]);
  assert.equal(decoded.channel, 'microphone');
  assert.equal(decoded.capturedAt, 1000);
});

test('chunks are numbered and stay in order across concurrent writes', async () => {
  const filePath = tempFile();
  const writer = new EncryptedAudioWriter({
    filePath,
    key: KEY,
    sessionId: 'session-1',
    channel: 'system',
  });
  for (let i = 0; i < 20; i += 1) {
    writer.write(pcm([i]), 1000 + i * 100, 100);
  }
  await writer.finish();

  const decoded = readLines(filePath).map((line) => decryptChunkLine(line, KEY));
  assert.deepEqual(
    decoded.map((chunk) => chunk.sequence),
    Array.from({ length: 20 }, (_, i) => i + 1),
  );
  assert.deepEqual(
    decoded.map((chunk) => chunk.samples[0]),
    Array.from({ length: 20 }, (_, i) => i),
  );
});

test('tracks the first and last captured timestamp for synchronization', async () => {
  const filePath = tempFile();
  const writer = new EncryptedAudioWriter({
    filePath,
    key: KEY,
    sessionId: 's',
    channel: 'microphone',
  });
  writer.write(pcm([1]), 5000, 100);
  writer.write(pcm([2]), 5100, 100);
  const stats = await writer.finish();
  assert.equal(stats.firstCapturedAt, 5000);
  assert.equal(stats.lastCapturedAt, 5100);
});

test('a saturated queue drops chunks and reports dropped duration instead of blocking', async () => {
  const filePath = tempFile();
  let releaseWrites;
  const gate = new Promise((resolve) => {
    releaseWrites = resolve;
  });
  const writer = new EncryptedAudioWriter({
    filePath,
    key: KEY,
    sessionId: 's',
    channel: 'system',
    maxQueuedChunks: 2,
    appendFileImpl: async (...args) => {
      await gate;
      return fs.promises.appendFile(...args);
    },
  });
  const states = [];
  writer.onState = (event) => states.push(event);

  // The first two chunks fill the bounded queue; disk writes are held open by
  // the gate, simulating a stall.
  writer.write(pcm([1]), 0, 100);
  writer.write(pcm([2]), 100, 100);
  writer.write(pcm([3]), 200, 100); // dropped: queue is full
  writer.write(pcm([4]), 300, 100); // dropped: queue is full

  assert.equal(writer.droppedChunks, 2);
  assert.equal(writer.droppedMs, 200);
  assert.ok(states.some((event) => event.state === 'degraded'));

  releaseWrites();
  const stats = await writer.finish();
  assert.equal(stats.chunkCount, 2);
  assert.equal(stats.droppedChunks, 2);
  assert.equal(stats.droppedMs, 200);
  // The queue drained cleanly, so backup is caught up again.
  assert.equal(stats.state, 'healthy');
});

test('memory never grows past the bounded queue regardless of write volume', () => {
  const filePath = tempFile();
  const writer = new EncryptedAudioWriter({
    filePath,
    key: KEY,
    sessionId: 's',
    channel: 'microphone',
    maxQueuedChunks: 4,
    appendFileImpl: () => new Promise(() => {}), // never resolves
  });
  for (let i = 0; i < 500; i += 1) writer.write(pcm([i]), i, 10);
  assert.ok(writer.queuedCount <= 4);
  assert.equal(writer.droppedChunks, 496);
});

test('a hard write failure is reported as failed and does not self-heal', async () => {
  const filePath = tempFile();
  const writer = new EncryptedAudioWriter({
    filePath,
    key: KEY,
    sessionId: 's',
    channel: 'system',
    appendFileImpl: async () => {
      throw new Error('ENOSPC: no space left on device');
    },
  });
  const states = [];
  writer.onState = (event) => states.push(event);

  writer.write(pcm([1]), 0, 100);
  const stats = await writer.finish();

  assert.equal(stats.state, 'failed');
  assert.match(stats.error, /ENOSPC/);
  assert.ok(states.some((event) => event.state === 'failed'));

  // Further writes are inert once failed — no pointless disk retries.
  writer.write(pcm([2]), 100, 100);
  assert.equal(writer.queuedCount, 0);
});

test('finish resolves even with zero chunks written', async () => {
  const filePath = tempFile();
  const writer = new EncryptedAudioWriter({
    filePath,
    key: KEY,
    sessionId: 's',
    channel: 'system',
  });
  const stats = await writer.finish();
  assert.equal(stats.chunkCount, 0);
  assert.equal(stats.firstCapturedAt, null);
  assert.equal(stats.state, 'healthy');
});

test('tampered ciphertext fails authentication rather than decrypting silently', async () => {
  const filePath = tempFile();
  const writer = new EncryptedAudioWriter({
    filePath,
    key: KEY,
    sessionId: 's',
    channel: 'microphone',
  });
  writer.write(pcm([42]), 0, 100);
  await writer.finish();

  const [line] = readLines(filePath);
  const record = JSON.parse(line);
  record.data = Buffer.from('tampered payload').toString('base64');
  assert.throws(() => decryptChunkLine(JSON.stringify(record), KEY));
});

test('a wrong key fails authentication', async () => {
  const filePath = tempFile();
  const writer = new EncryptedAudioWriter({
    filePath,
    key: KEY,
    sessionId: 's',
    channel: 'microphone',
  });
  writer.write(pcm([42]), 0, 100);
  await writer.finish();

  const [line] = readLines(filePath);
  assert.throws(() => decryptChunkLine(line, crypto.randomBytes(32)));
});
