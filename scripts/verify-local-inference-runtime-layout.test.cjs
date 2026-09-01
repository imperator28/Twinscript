const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertRuntimeLayout,
  validateRuntimeLayoutManifest,
} = require('./local-inference-runtime-layout.cjs');

const inventoryEntry = (path) => ({ path, size: 1, sha256: 'a'.repeat(64) });

const validManifest = () => ({
  schemaVersion: 2,
  runtime: 'openvino-genai-2026.3+llama.cpp-b9940',
  runtimeFamilies: {
    cpu: {
      revision: 'b9940',
      entryPoint: 'llama/cpu/llama-server.exe',
      files: ['llama/cpu/llama-server.exe', 'llama/cpu/ggml.dll'],
    },
    cuda: {
      revision: 'b9940',
      entryPoint: 'llama/cuda/llama-server.exe',
      files: ['llama/cuda/llama-server.exe', 'llama/cuda/ggml-cuda.dll'],
    },
  },
  files: [
    inventoryEntry('twinscript-local-inference.exe'),
    inventoryEntry('llama/cpu/llama-server.exe'),
    inventoryEntry('llama/cpu/ggml.dll'),
    inventoryEntry('llama/cuda/llama-server.exe'),
    inventoryEntry('llama/cuda/ggml-cuda.dll'),
  ],
});

test('accepts isolated CPU and CUDA families from one pinned revision', () => {
  assert.deepEqual(validateRuntimeLayoutManifest(validManifest()), {
    cpuEntryPoint: 'llama/cpu/llama-server.exe',
    cudaEntryPoint: 'llama/cuda/llama-server.exe',
    revision: 'b9940',
  });
});

test('rejects schema 1 and missing family entry points', () => {
  assert.throws(
    () => validateRuntimeLayoutManifest({ ...validManifest(), schemaVersion: 1 }),
    /schema 2/i,
  );
  const manifest = validManifest();
  delete manifest.runtimeFamilies.cuda.entryPoint;
  assert.throws(() => validateRuntimeLayoutManifest(manifest), /CUDA entry point/i);
});

test('rejects CPU and CUDA families built from different revisions', () => {
  const manifest = validManifest();
  manifest.runtimeFamilies.cuda.revision = 'b9941';
  assert.throws(() => validateRuntimeLayoutManifest(manifest), /same pinned revision/i);
});

test('rejects family files outside their isolated directory', () => {
  const manifest = validManifest();
  manifest.runtimeFamilies.cuda.files.push('llama/cpu/ggml.dll');
  assert.throws(() => validateRuntimeLayoutManifest(manifest), /outside llama\/cuda/i);
});

test('rejects a family file missing from the hashed inventory', () => {
  const manifest = validManifest();
  manifest.files = manifest.files.filter(({ path }) => path !== 'llama/cuda/ggml-cuda.dll');
  assert.throws(() => validateRuntimeLayoutManifest(manifest), /hashed inventory/i);
});

test('rejects path traversal and malformed global inventory entries', () => {
  const manifest = validManifest();
  manifest.files.push(inventoryEntry('../escape.dll'));
  assert.throws(() => validateRuntimeLayoutManifest(manifest), /safe relative path/i);
});

test('reads PowerShell-authored manifests defensively when a UTF-8 BOM is present', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twinscript-layout-'));
  for (const family of ['cpu', 'cuda']) {
    const directory = path.join(root, 'llama', family);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'llama-server.exe'), 'fixture');
  }
  fs.writeFileSync(
    path.join(root, 'runtime-manifest.json'),
    `\uFEFF${JSON.stringify(validManifest())}`,
    'utf8',
  );

  assert.equal(assertRuntimeLayout(root).revision, 'b9940');
});
