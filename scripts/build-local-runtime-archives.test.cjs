const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { buildRuntimeArchives } = require('./build-local-runtime-archives.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-archives-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDirectory = path.join(root, 'source');
  const outputDirectory = path.join(root, 'out');
  const files = [];
  for (const name of ['twinscript-local-inference.exe', 'openvino.dll', 'llama/cpu/llama-server.exe', 'llama/cuda/llama-server.exe', 'llama/cuda/cublas.dll']) {
    const data = Buffer.from(name);
    await fs.mkdir(path.dirname(path.join(sourceDirectory, name)), { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, name), data);
    files.push({ path: name, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
  }
  const manifest = { schemaVersion: 2, runtimeFamilies: Object.fromEntries(['cpu', 'cuda'].map(family => [family, { revision: 'b1', entryPoint: `llama/${family}/llama-server.exe`, files: files.filter(f => f.path.startsWith(`llama/${family}/`)).map(f => f.path) }])), files };
  await fs.writeFile(path.join(sourceDirectory, 'runtime-manifest.json'), JSON.stringify(manifest));
  return { root, sourceDirectory, outputDirectory, manifest };
}

test('splits CPU and CUDA inventories without mutating staged source', { skip: process.platform !== 'win32' }, async t => {
  const fixtureData = await fixture(t);
  const { sourceDirectory, outputDirectory, manifest, root } = fixtureData;
  const result = await buildRuntimeArchives(fixtureData);
  assert.equal(result.runtimes.length, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(sourceDirectory, 'runtime-manifest.json'), 'utf8')), manifest);
  const { extractRuntimeArchive } = require('../electron/captions/local-runtime-manager');
  for (const runtime of result.runtimes) {
    const data = await fs.readFile(path.join(outputDirectory, runtime.fileName));
    assert.equal(data.length, runtime.size);
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'), runtime.sha256);
    const stage = path.join(root, runtime.id);
    await fs.mkdir(stage);
    await extractRuntimeArchive(path.join(outputDirectory, runtime.fileName), stage, { signal: new AbortController().signal, runtime });
    const extracted = JSON.parse(await fs.readFile(path.join(stage, 'runtime-manifest.json'), 'utf8'));
    if (runtime.family === 'cpu') {
      assert.equal(extracted.runtimeFamilies.cuda, undefined);
      assert.equal(extracted.files.some(f => f.path.startsWith('llama/cuda/')), false);
      await assert.rejects(fs.stat(path.join(stage, 'llama/cuda')));
      assert.ok((await fs.stat(path.join(stage, 'openvino.dll'))).isFile());
    } else {
      assert.deepEqual(extracted.files, manifest.files);
      await assert.rejects(fs.stat(path.join(stage, 'twinscript-local-inference.exe')));
      assert.ok((await fs.stat(path.join(stage, 'llama/cuda/cublas.dll'))).isFile());
    }
  }
  await assert.rejects(buildRuntimeArchives(fixtureData), /exist/i);
});

test('refuses corrupted source files before publishing archives', async t => {
  const input = await fixture(t);
  await fs.writeFile(path.join(input.sourceDirectory, 'openvino.dll'), 'bad');
  await assert.rejects(buildRuntimeArchives(input), /hash|inventory|size/i);
});

test('refuses output directories inside staged source including dot-prefixed names', async t => {
  const input = await fixture(t);
  await assert.rejects(buildRuntimeArchives({ ...input, outputDirectory: path.join(input.sourceDirectory, '..archives') }), /outside/);
});
