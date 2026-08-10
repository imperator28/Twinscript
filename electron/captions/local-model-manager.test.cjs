const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LocalModelManager } = require('./local-model-manager');


function manifestFor(bytes) {
  return {
    schemaVersion: 1,
    runtimeVersion: 'test',
    models: [{
      id: 'whisper-small',
      version: 'v1',
      files: [{
        path: 'model.bin',
        url: 'https://example.invalid/model.bin',
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      }],
    }],
  };
}

test('download refuses to start during an active meeting', async () => {
  const manager = new LocalModelManager({
    manifest: manifestFor(Buffer.from('model')),
    root: os.tmpdir(),
    sessionActive: () => true,
  });

  await assert.rejects(manager.download('whisper-small'), { code: 'meeting_active' });
});

test('download verifies size and hash before the model becomes ready', async () => {
  const bytes = Buffer.from('verified-model');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-models-'));
  const manager = new LocalModelManager({
    manifest: manifestFor(bytes),
    root,
    sessionActive: () => false,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map(),
      arrayBuffer: async () => bytes,
    }),
  });

  await manager.download('whisper-small');

  assert.equal(manager.status().models['whisper-small'].ready, true);
  assert.deepEqual(fs.readFileSync(path.join(root, 'whisper-small', 'v1', 'model.bin')), bytes);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a hash mismatch never replaces the ready path', async () => {
  const expected = Buffer.from('expected');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-models-'));
  const manager = new LocalModelManager({
    manifest: manifestFor(expected),
    root,
    sessionActive: () => false,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map(),
      arrayBuffer: async () => Buffer.from('tampered'),
    }),
  });

  await assert.rejects(manager.download('whisper-small'), { code: 'local_model_hash_mismatch' });
  assert.equal(manager.status().models['whisper-small'].ready, false);
  fs.rmSync(root, { recursive: true, force: true });
});
