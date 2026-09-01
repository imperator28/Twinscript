const fs = require('node:fs');
const path = require('node:path');

const isSafeRelativePath = (value) =>
  typeof value === 'string'
  && value.length > 0
  && !value.includes('\\')
  && !path.posix.isAbsolute(value)
  && !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');

function validateRuntimeLayoutManifest(manifest, { requireCuda = true } = {}) {
  if (!manifest || manifest.schemaVersion !== 2) {
    throw new Error('Local inference runtime manifest must use schema 2.');
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error('Local inference runtime manifest requires a hashed file inventory.');
  }

  const inventory = new Set();
  for (const entry of manifest.files) {
    if (!entry || !isSafeRelativePath(entry.path)) {
      throw new Error('Every runtime inventory entry must use a safe relative path.');
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/i.test(entry.sha256 || '')) {
      throw new Error(`Runtime inventory metadata is invalid for ${entry.path}.`);
    }
    if (inventory.has(entry.path)) throw new Error(`Duplicate runtime inventory path: ${entry.path}.`);
    inventory.add(entry.path);
  }

  const families = manifest.runtimeFamilies;
  if (!families || typeof families !== 'object') {
    throw new Error('Runtime manifest is missing CPU and CUDA family metadata.');
  }
  const expectedEntryPoints = {
    cpu: 'llama/cpu/llama-server.exe',
    cuda: 'llama/cuda/llama-server.exe',
  };
  const requiredFamilies = requireCuda ? ['cpu', 'cuda'] : ['cpu'];
  for (const familyName of requiredFamilies) {
    const family = families[familyName];
    const displayName = familyName.toUpperCase();
    if (!family || family.entryPoint !== expectedEntryPoints[familyName]) {
      throw new Error(`${displayName} entry point must be ${expectedEntryPoints[familyName]}.`);
    }
    if (typeof family.revision !== 'string' || !family.revision) {
      throw new Error(`${displayName} runtime revision is missing.`);
    }
    if (!Array.isArray(family.files) || !family.files.includes(family.entryPoint)) {
      throw new Error(`${displayName} family must list its entry point.`);
    }
    const prefix = `llama/${familyName}/`;
    for (const file of family.files) {
      if (!isSafeRelativePath(file) || !file.startsWith(prefix)) {
        throw new Error(`${displayName} family file is outside ${prefix.slice(0, -1)}: ${String(file)}.`);
      }
      if (!inventory.has(file)) {
        throw new Error(`${displayName} family file is missing from the global hashed inventory: ${file}.`);
      }
    }
  }
  if (requireCuda && families.cpu.revision !== families.cuda.revision) {
    throw new Error('CPU and CUDA runtime families must use the same pinned revision.');
  }

  return {
    cpuEntryPoint: families.cpu.entryPoint,
    cudaEntryPoint: families.cuda?.entryPoint ?? null,
    revision: families.cpu.revision,
  };
}

function assertRuntimeLayout(root, fsImpl = fs, options = {}) {
  const manifestPath = path.join(root, 'runtime-manifest.json');
  const manifest = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  const layout = validateRuntimeLayoutManifest(manifest, options);
  for (const entryPoint of [layout.cpuEntryPoint, layout.cudaEntryPoint].filter(Boolean)) {
    const absolutePath = path.resolve(root, ...entryPoint.split('/'));
    if (!fsImpl.statSync(absolutePath).isFile()) {
      throw new Error(`Missing packaged runtime entry point: ${entryPoint}.`);
    }
  }
  return { manifest, ...layout };
}

module.exports = {
  assertRuntimeLayout,
  validateRuntimeLayoutManifest,
};
