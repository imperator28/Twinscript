const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { LocalModelManager } = require('./local-model-manager');

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function manifestFor(whisper = Buffer.from('whisper'), translator = Buffer.from('translator')) {
  return {
    schemaVersion: 1,
    runtimeVersion: 'test',
    models: [
      {
        id: 'whisper-small', version: 'whisper-v1', displayName: 'Whisper Small',
        purpose: 'Speech recognition', expectedDevice: 'NPU',
        files: [{ path: 'model.bin', url: 'https://example.invalid/whisper.bin', size: whisper.length, sha256: digest(whisper) }],
      },
      {
        id: 'hy-mt2-1.8b', version: 'translator-v1', displayName: 'HY-MT2 1.8B',
        purpose: 'Translation', expectedDevice: 'GPU',
        files: [{ path: 'runtime/model.bin', url: 'https://example.invalid/translator.bin', size: translator.length, sha256: digest(translator) }],
      },
    ],
  };
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-models-'));
}

function streamResponse(bytes, status = 200) {
  return {
    ok: true,
    status,
    body: new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 2) controller.enqueue(bytes.subarray(offset, offset + 2));
        controller.close();
      },
    }),
  };
}

function managerFor({ root = tempRoot(), bytes, sessionActive = () => false, fetchImpl, onProgress } = {}) {
  const manifest = manifestFor(bytes, bytes);
  return { root, manager: new LocalModelManager({ manifest, root, sessionActive, fetchImpl, onProgress }) };
}

test('status exposes both approved models with lifecycle metadata while preserving ready', () => {
  const { root, manager } = managerFor({ bytes: Buffer.from('model') });
  const status = manager.status();

  assert.deepEqual(Object.keys(status.models), ['whisper-small', 'hy-mt2-1.8b']);
  assert.deepEqual(status.models['whisper-small'], {
    id: 'whisper-small', displayName: 'Whisper Small', purpose: 'Speech recognition', expectedDevice: 'NPU', version: 'whisper-v1',
    downloadBytes: 5, installedBytes: 0, downloadedBytes: 0, installed: false, verified: false, phase: 'not-installed', ready: false,
    repairRecommended: false, error: null,
  });
  assert.deepEqual(status.models['hy-mt2-1.8b'], {
    id: 'hy-mt2-1.8b', displayName: 'HY-MT2 1.8B', purpose: 'Translation', expectedDevice: 'GPU', version: 'translator-v1',
    downloadBytes: 5, installedBytes: 0, downloadedBytes: 0, installed: false, verified: false, phase: 'not-installed', ready: false,
    repairRecommended: false, error: null,
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test('download streams chunks, emits downloading/verifying/ready progress, and becomes ready', async () => {
  const bytes = Buffer.from('verified-model');
  const progress = [];
  const { root, manager } = managerFor({
    bytes,
    fetchImpl: async () => streamResponse(bytes),
    onProgress: (event) => progress.push(event),
  });

  await manager.download('whisper-small');

  assert.equal(manager.status().models['whisper-small'].ready, true);
  assert.deepEqual(fs.readFileSync(path.join(root, 'whisper-small', 'whisper-v1', 'model.bin')), bytes);
  assert.deepEqual(
    progress.map(({ phase, downloadedBytes }) => [phase, downloadedBytes]),
    [
      ['downloading', 0], ['downloading', 2], ['downloading', 4], ['downloading', 6],
      ['downloading', 8], ['downloading', 10], ['downloading', 12], ['downloading', 14],
      ['verifying', 0], ['verifying', 14], ['ready', 14],
    ],
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('download resumes a partial file with Range requests', async () => {
  const bytes = Buffer.from('resumable-model');
  const { root, manager } = managerFor({ bytes, fetchImpl: async (_url, options) => {
    assert.equal(options.headers.Range, 'bytes=4-');
    return streamResponse(bytes.subarray(4), 206);
  } });
  const partial = path.join(root, 'whisper-small', 'whisper-v1', 'model.bin.partial');
  fs.mkdirSync(path.dirname(partial), { recursive: true });
  fs.writeFileSync(partial, bytes.subarray(0, 4));

  await manager.download('whisper-small');

  assert.deepEqual(fs.readFileSync(path.join(root, 'whisper-small', 'whisper-v1', 'model.bin')), bytes);
  fs.rmSync(root, { recursive: true, force: true });
});

test('download restarts a partial file when server ignores Range', async () => {
  const bytes = Buffer.from('range-ignored');
  const { root, manager } = managerFor({ bytes, fetchImpl: async () => streamResponse(bytes, 200) });
  const partial = path.join(root, 'whisper-small', 'whisper-v1', 'model.bin.partial');
  fs.mkdirSync(path.dirname(partial), { recursive: true });
  fs.writeFileSync(partial, Buffer.from('stale'));

  await manager.download('whisper-small');

  assert.deepEqual(fs.readFileSync(path.join(root, 'whisper-small', 'whisper-v1', 'model.bin')), bytes);
  fs.rmSync(root, { recursive: true, force: true });
});

test('download rejects missing response bodies without using whole-response buffering', async () => {
  const { root, manager } = managerFor({ bytes: Buffer.from('model'), fetchImpl: async () => ({ ok: true, status: 200 }) });

  await assert.rejects(manager.download('whisper-small'), { code: 'local_model_download_failed' });
  assert.equal(manager.status().models['whisper-small'].phase, 'failed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('download rejects an incorrectly sized file and removes its partial', async () => {
  const bytes = Buffer.from('expected-model');
  const { root, manager } = managerFor({ bytes, fetchImpl: async () => streamResponse(Buffer.from('short')) });
  const partial = path.join(root, 'whisper-small', 'whisper-v1', 'model.bin.partial');

  await assert.rejects(manager.download('whisper-small'), { code: 'local_model_size_mismatch' });
  assert.equal(fs.existsSync(partial), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('transient download failures preserve partials but hash-mismatched partials are deleted', async () => {
  const bytes = Buffer.from('expected-model');
  const { root, manager } = managerFor({ bytes, fetchImpl: async () => { throw new Error('temporary network error'); } });
  const partial = path.join(root, 'whisper-small', 'whisper-v1', 'model.bin.partial');
  fs.mkdirSync(path.dirname(partial), { recursive: true });
  fs.writeFileSync(partial, bytes.subarray(0, 3));
  await assert.rejects(manager.download('whisper-small'), { code: 'local_model_download_failed' });
  assert.equal(fs.existsSync(partial), true);

  manager.fetchImpl = async () => streamResponse(Buffer.alloc(bytes.length, 'x'));
  await assert.rejects(manager.download('whisper-small'), { code: 'local_model_hash_mismatch' });
  assert.equal(fs.existsSync(partial), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a retained download failure overrides a stale same-size ready marker', async () => {
  const bytes = Buffer.from('verified-model');
  const { root, manager } = managerFor({ bytes, fetchImpl: async () => streamResponse(bytes) });
  await manager.download('whisper-small');
  const destination = path.join(root, 'whisper-small', 'whisper-v1', 'model.bin');
  fs.writeFileSync(destination, Buffer.alloc(bytes.length, 'x'));
  manager.fetchImpl = async () => { throw new Error('network down'); };

  await assert.rejects(manager.download('whisper-small'), { code: 'local_model_download_failed' });

  const row = manager.status().models['whisper-small'];
  assert.equal(row.ready, false);
  assert.equal(row.phase, 'failed');
  assert.equal(row.error.code, 'local_model_download_failed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a failed replacement of a same-size corrupt model invalidates its marker for a new manager', async () => {
  const bytes = Buffer.from('verified-model');
  const { root, manager } = managerFor({ bytes, fetchImpl: async () => streamResponse(bytes) });
  await manager.download('whisper-small');
  fs.writeFileSync(path.join(root, 'whisper-small', 'whisper-v1', 'model.bin'), Buffer.alloc(bytes.length, 'x'));
  manager.fetchImpl = async () => { throw new Error('network down'); };

  await assert.rejects(manager.download('whisper-small'), { code: 'local_model_download_failed' });

  const reloaded = new LocalModelManager({ manifest: manager.manifest, root });
  const row = reloaded.status().models['whisper-small'];
  assert.equal(row.ready, false);
  assert.equal(row.phase, 'repair-needed');
  assert.equal(fs.existsSync(path.join(root, 'whisper-small', 'whisper-v1', '.verified.json')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('explicit verify hashes an unmarked complete model and writes a ready marker', async () => {
  const bytes = Buffer.from('verified-model');
  const { root, manager } = managerFor({ bytes });
  const directory = path.join(root, 'whisper-small', 'whisper-v1');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'model.bin'), bytes);

  const row = await manager.verify('whisper-small');

  assert.equal(row.ready, true);
  assert.equal(row.phase, 'ready');
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, '.verified.json'), 'utf8')).files['model.bin'], digest(bytes));
  fs.rmSync(root, { recursive: true, force: true });
});

test('a write failure preserves an existing verified model and marker', async () => {
  const bytes = Buffer.from('verified-model');
  const { root, manager } = managerFor({ bytes, fetchImpl: async () => streamResponse(bytes) });
  await manager.download('whisper-small');
  const directory = path.join(root, 'whisper-small', 'whisper-v1');
  const destination = path.join(directory, 'model.bin');
  const marker = path.join(directory, '.verified.json');
  const previousMarker = fs.readFileSync(marker);
  const originalWriteFile = fsp.writeFile;
  fsp.writeFile = async (filePath, ...args) => {
    if (String(filePath).includes('.verified.json.')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return originalWriteFile(filePath, ...args);
  };
  try {
    await assert.rejects(manager.download('whisper-small'), { code: 'ENOSPC' });
  } finally {
    fsp.writeFile = originalWriteFile;
  }

  assert.deepEqual(fs.readFileSync(destination), bytes);
  assert.deepEqual(fs.readFileSync(marker), previousMarker);
  assert.equal(manager.status().models['whisper-small'].ready, false);
  assert.equal(manager.status().models['whisper-small'].phase, 'failed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('explicit verify hashes declared files, invalidates the marker, and recommends repair on corruption', async () => {
  const bytes = Buffer.from('verified-model');
  const { root, manager } = managerFor({ bytes, fetchImpl: async () => streamResponse(bytes) });
  await manager.download('whisper-small');
  fs.writeFileSync(path.join(root, 'whisper-small', 'whisper-v1', 'model.bin'), Buffer.alloc(bytes.length, 'x'));

  await assert.rejects(manager.verify('whisper-small'), { code: 'local_model_hash_mismatch' });

  const row = manager.status().models['whisper-small'];
  assert.equal(row.ready, false);
  assert.equal(row.phase, 'repair-needed');
  assert.equal(row.repairRecommended, true);
  assert.equal(fs.existsSync(path.join(root, 'whisper-small', 'whisper-v1', '.verified.json')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('repair keeps valid files, replaces corrupt files, and verifies the model', async () => {
  const whisper = Buffer.from('whisper-good');
  const translator = Buffer.from('translator-good');
  const root = tempRoot();
  const manifest = manifestFor(whisper, translator);
  let calls = 0;
  const manager = new LocalModelManager({ manifest, root, fetchImpl: async (url) => {
    calls += 1;
    return streamResponse(url.includes('whisper') ? whisper : translator);
  } });
  await manager.download('whisper-small');
  await manager.download('hy-mt2-1.8b');
  fs.writeFileSync(path.join(root, 'whisper-small', 'whisper-v1', 'model.bin'), Buffer.from('corrupt'));

  await manager.repair('whisper-small');

  assert.equal(calls, 3);
  assert.equal(manager.status().models['whisper-small'].ready, true);
  assert.equal(manager.status().models['hy-mt2-1.8b'].ready, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('every mutation is locked during meetings and concurrent same-model mutations are rejected', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { root, manager } = managerFor({ bytes: Buffer.from('model'), fetchImpl: async () => {
    await gate;
    return streamResponse(Buffer.from('model'));
  } });
  const active = manager.download('whisper-small');
  await assert.rejects(manager.remove('whisper-small'), { code: 'local_model_mutation_active' });
  await assert.rejects(manager.verify('whisper-small'), { code: 'local_model_mutation_active' });
  await assert.rejects(manager.repair('whisper-small'), { code: 'local_model_mutation_active' });
  release();
  await active;
  const blocked = new LocalModelManager({ manifest: manifestFor(), root, sessionActive: () => true });
  for (const action of ['download', 'verify', 'repair', 'remove']) {
    await assert.rejects(blocked[action]('whisper-small'), { code: 'meeting_active' });
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('remove deletes only the selected model version and clears its failure state', async () => {
  const bytes = Buffer.from('model');
  const { root, manager } = managerFor({ bytes, fetchImpl: async () => streamResponse(bytes) });
  await manager.download('whisper-small');
  await manager.download('hy-mt2-1.8b');

  const row = await manager.remove('whisper-small');

  assert.equal(row.phase, 'not-installed');
  assert.equal(fs.existsSync(path.join(root, 'whisper-small', 'whisper-v1')), false);
  assert.equal(manager.status().models['hy-mt2-1.8b'].ready, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('remove retains a filesystem failure in the model status', async () => {
  const { root, manager } = managerFor({ bytes: Buffer.from('model') });
  const directory = path.join(root, 'whisper-small', 'whisper-v1');
  const originalRm = fsp.rm;
  fsp.rm = async (filePath, options) => {
    if (path.resolve(filePath) === path.resolve(directory)) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
    return originalRm(filePath, options);
  };
  try {
    await assert.rejects(manager.remove('whisper-small'), { code: 'EACCES' });
  } finally {
    fsp.rm = originalRm;
  }

  const row = manager.status().models['whisper-small'];
  assert.equal(row.phase, 'failed');
  assert.equal(row.ready, false);
  assert.equal(row.error.code, 'EACCES');
  fs.rmSync(root, { recursive: true, force: true });
});

test('unknown model IDs are rejected by every action', async () => {
  const { root, manager } = managerFor({ bytes: Buffer.from('model') });
  for (const action of ['download', 'verify', 'repair', 'remove']) {
    await assert.rejects(manager[action]('unknown'), { code: 'local_model_unknown' });
  }
  fs.rmSync(root, { recursive: true, force: true });
});
