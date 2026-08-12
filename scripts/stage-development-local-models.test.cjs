const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

test('stages only manifest-declared local files into versioned model folders', async () => {
  const { stageDevelopmentModels } = await import('./stage-development-local-models.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-development-local-models-'));
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'target');
  const whisper = Buffer.from('whisper');
  const hyMt2 = Buffer.from('hy-mt2');
  fs.mkdirSync(path.join(sourceRoot, 'whisper-small'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, 'source-snapshots', 'hy-mt2-1.8b-gguf'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'whisper-small', 'openvino_encoder_model.xml'), whisper);
  fs.writeFileSync(path.join(sourceRoot, 'source-snapshots', 'hy-mt2-1.8b-gguf', 'Hy-MT2-1.8B-Q4_K_M.gguf'), hyMt2);
  const manifest = {
    models: [
      { id: 'whisper-small', version: 'whisper-v1', files: [{ path: 'openvino_encoder_model.xml', size: whisper.length, sha256: digest(whisper) }] },
      { id: 'hy-mt2-1.8b', version: 'hy-v1', files: [{ path: 'Hy-MT2-1.8B-Q4_K_M.gguf', size: hyMt2.length, sha256: digest(hyMt2) }] },
    ],
  };

  await stageDevelopmentModels({ sourceRoot, targetRoot, manifest });

  assert.deepEqual(fs.readFileSync(path.join(targetRoot, 'whisper-small', 'whisper-v1', 'openvino_encoder_model.xml')), whisper);
  assert.deepEqual(fs.readFileSync(path.join(targetRoot, 'hy-mt2-1.8b', 'hy-v1', 'Hy-MT2-1.8B-Q4_K_M.gguf')), hyMt2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('refuses to stage a source file whose declared hash does not match', async () => {
  const { stageDevelopmentModels } = await import('./stage-development-local-models.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-development-local-models-'));
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'target');
  fs.mkdirSync(path.join(sourceRoot, 'whisper-small'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'whisper-small', 'openvino_encoder_model.xml'), 'wrong');

  await assert.rejects(stageDevelopmentModels({
    sourceRoot,
    targetRoot,
    manifest: { models: [
      { id: 'whisper-small', version: 'whisper-v1', files: [{ path: 'openvino_encoder_model.xml', size: 5, sha256: 'a'.repeat(64) }] },
    ] },
  }), /hash mismatch/i);
  assert.equal(fs.existsSync(path.join(targetRoot, 'whisper-small', 'whisper-v1', 'openvino_encoder_model.xml')), false);
  fs.rmSync(root, { recursive: true, force: true });
});
