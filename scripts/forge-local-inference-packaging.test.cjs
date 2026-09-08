const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const crypto = require('node:crypto');
const { canonicalJson } = require('../electron/captions/local-model-manifest');

const forgeConfig = require('../forge.config.js');

// The rule this file guards was deliberately inverted when the installer was
// split from the runtime, so it reads backwards at first glance: packaging now
// fails when a local-inference runtime IS present.
//
// It used to fail when the runtime was absent, because local processing was a
// selectable pipeline whose verified runtime had to ship or the Settings option
// could never start. The runtime is now a verified on-demand download, and
// bundling it puts roughly a gigabyte of CUDA and OpenVINO payload back into
// every installer - which is the single thing the split exists to prevent. A
// silent regression there is invisible in CI and obvious only to whoever waits
// on the download, so it is asserted here rather than trusted.

/** Stage the signed catalog that `extraResource` copies, and return its directory. */
function stageCatalog(packageRoot) {
  const catalogRoot = path.join(packageRoot, 'resources', 'resources', 'local-models');
  fs.mkdirSync(catalogRoot, { recursive: true });
  const manifest = { schemaVersion: 1, runtimeVersion: 'test-v1', models:
    ['whisper-small', 'hy-mt2-1.8b'].map((id) => ({
      id, version: 'test-v1', displayName: id, purpose: 'Test fixture',
      license: 'MIT', source: 'Test fixture', expectedDevice: 'CPU',
      unpackedSize: 1, launchPath: 'model.bin',
      files: [{ path: 'model.bin', size: 1, sha256: 'a'.repeat(64), url: 'https://example.invalid/model.bin' }],
    })) };
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(catalogRoot, 'model-manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(catalogRoot, 'model-manifest.sig'), crypto.sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString('base64'));
  fs.writeFileSync(path.join(catalogRoot, 'model-manifest-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  return catalogRoot;
}

/**
 * Run the hook the way Electron Packager does.
 *
 * The catalog only exists once `extraResource` has been copied, which happens
 * after the ordinary afterCopy hook - so validation has to sit here, and the
 * structural test below pins that it has not drifted back.
 */
function runHook(packageRoot, platform = 'win32') {
  const [hook] = forgeConfig.packagerConfig.afterCopyExtraResources;
  return new Promise((resolve, reject) => {
    hook(packageRoot, '40.0.0', platform, 'x64', (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** A fresh package root per case, removed even when the assertion fails. */
async function withPackageRoot(body) {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'twinscript-forge-hook-'));
  try {
    await body(packageRoot);
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
}

test('local inference is validated only after extra resources are copied', () => {
  assert.ok(Array.isArray(forgeConfig.packagerConfig.afterCopyExtraResources));
  const [hook] = forgeConfig.packagerConfig.afterCopyExtraResources;
  assert.equal(typeof hook, 'function');
  assert.doesNotMatch(
    forgeConfig.hooks.packageAfterCopy.toString(),
    /validatePackagedLocalInference/,
  );
});

test('the installer carries no bundled local-inference runtime', async () => {
  // extraResource must not name the runtime, or every installer regains it.
  assert.ok(
    !forgeConfig.packagerConfig.extraResource.some(entry => /local-inference-host/.test(entry)),
    'extraResource must not package the local-inference runtime',
  );
  await withPackageRoot(async (packageRoot) => {
    stageCatalog(packageRoot);
    await assert.doesNotReject(runHook(packageRoot));
  });
});

test('packaging fails when a local-inference runtime was bundled', async () => {
  await withPackageRoot(async (packageRoot) => {
    stageCatalog(packageRoot);
    fs.mkdirSync(path.join(packageRoot, 'resources', 'local-inference-host'), { recursive: true });
    await assert.rejects(
      runHook(packageRoot),
      /must be downloaded separately, not bundled/,
    );
  });
});

test('packaging fails when the signed catalog is incomplete', async () => {
  await withPackageRoot(async (packageRoot) => {
    const catalogRoot = stageCatalog(packageRoot);
    fs.rmSync(path.join(catalogRoot, 'model-manifest.sig'));
    await assert.rejects(runHook(packageRoot), /Missing signed release catalog file/);
  });
});

test('packaging fails rather than ship anything else from the catalog directory', async () => {
  await withPackageRoot(async (packageRoot) => {
    const catalogRoot = stageCatalog(packageRoot);
    // The signing key lives beside the catalog while a release is prepared.
    // Packaging it would publish the authority to sign any future manifest.
    fs.writeFileSync(path.join(catalogRoot, 'model-manifest-private.pem'), 'not a real key');
    await assert.rejects(runHook(packageRoot), /never package private signing material/);
  });
});

test('the runtime rule is Windows-only, so other platforms still package', async () => {
  await withPackageRoot(async (packageRoot) => {
    // No catalog staged at all: local inference is a Windows pipeline, and
    // validating it elsewhere would fail a macOS or Linux build for a resource
    // those builds never carry.
    await assert.doesNotReject(runHook(packageRoot, 'darwin'));
  });
});
