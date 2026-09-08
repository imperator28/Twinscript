// Prepare verified, flat release assets and a signed catalog. Publishing is a
// separate operation; this command never uploads or changes repository visibility.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalJson, validateManifest } = require('../electron/captions/local-model-manifest');
const { WHISPER_SMALL_REQUIRED_PATHS } = require('../electron/captions/local-model-development-catalog');

/**
 * Read and verify the runtime archives this release will carry.
 *
 * `scripts/build-local-runtime-archives.cjs` records each archive's size and
 * digest as it writes them. Both are re-checked here against the bytes actually
 * on disk, because building and releasing are separate commands: an archive
 * that changed in between would be published under a digest the client then
 * refuses, and the failure would surface as a download that can never complete
 * rather than as a bad release.
 */
async function readVerifiedRuntimes(runtimeRoot, base) {
  const indexPath = path.join(runtimeRoot, 'runtime-archives.json');
  if (!fs.existsSync(indexPath)) {
    throw new Error('Runtime directory has no runtime-archives.json; build the archives first.');
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  if (!index || !Array.isArray(index.runtimes) || index.runtimes.length === 0) {
    throw new Error('runtime-archives.json lists no runtime archives.');
  }
  const entries = [];
  const sources = [];
  for (const runtime of index.runtimes) {
    const { fileName } = runtime || {};
    // The name is read from a file and then used both as a copy destination and
    // as a URL, so it is constrained to a plain archive name rather than
    // trusted to stay inside the release directory.
    if (typeof fileName !== 'string' || fileName !== path.basename(fileName)
        || !/^[A-Za-z0-9._-]+\.zip$/.test(fileName)) {
      throw new Error(`Unsafe runtime archive name: ${String(fileName)}`);
    }
    const source = path.join(runtimeRoot, fileName);
    if (!fs.existsSync(source)) throw new Error(`Missing runtime archive: ${fileName}`);
    const stat = fs.statSync(source);
    if (!stat.isFile()) throw new Error(`Not a file: ${source}`);
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(source)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    if (stat.size !== runtime.size || sha256 !== String(runtime.sha256).toLowerCase()) {
      throw new Error(`Runtime archive failed verification: ${fileName}`);
    }
    // fileName is deliberately not carried into the manifest: the URL already
    // names the asset, and the client resolves downloads from the URL alone.
    entries.push({
      id: runtime.id,
      family: runtime.family,
      revision: runtime.revision,
      size: stat.size,
      unpackedSize: runtime.unpackedSize,
      sha256,
      url: new URL(fileName, base).href,
    });
    sources.push({ source, asset: fileName });
  }
  return { entries, sources };
}

async function prepare({ modelRoot, outputRoot, baseUrl, runtimeRoot }) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('Supply an HTTPS release asset directory without credentials, query, or fragment.');
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  if (fs.existsSync(outputRoot)) throw new Error('Output directory already exists; choose a new release directory.');
  const definitions = [
    { id: 'whisper-small', version: 'openvino-int8-973afd24965f72e3', displayName: 'Whisper Small', purpose: 'Speech recognition', expectedDevice: 'NPU', license: 'MIT', source: 'openai/whisper-small OpenVINO INT8 export', launchPath: '.' },
    { id: 'hy-mt2-1.8b', version: 'q4-k-m-1cd5208700acedef', displayName: 'HY-MT2 1.8B', purpose: 'English and Chinese translation', expectedDevice: 'CPU', license: 'Apache-2.0', source: 'tencent/Hy-MT2-1.8B-GGUF Q4_K_M', launchPath: 'Hy-MT2-1.8B-Q4_K_M.gguf' },
  ];
  const manifest = { schemaVersion: 1, runtimeVersion: 'openvino-genai-2026.3-llama-b9940', models: [] };
  const sources = [];
  for (const model of definitions) {
    const root = path.join(modelRoot, model.id, model.version);
    const marker = JSON.parse(fs.readFileSync(path.join(root, '.verified.json'), 'utf8'));
    if (marker.version !== model.version) throw new Error(`Unexpected installed version for ${model.id}`);
    const files = [];
    const names = model.id === 'whisper-small' ? WHISPER_SMALL_REQUIRED_PATHS : [model.launchPath];
    for (const name of names) {
      const source = path.join(root, name);
      const stat = fs.statSync(source);
      if (!stat.isFile()) throw new Error(`Not a file: ${source}`);
      const hash = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(source)) hash.update(chunk);
      const sha256 = hash.digest('hex');
      if (marker.files[name] !== sha256) throw new Error(`Installed file failed verification: ${name}`);
      const asset = `${model.id}-${name}`;
      files.push({ path: name, size: stat.size, sha256, url: new URL(asset, base).href });
      sources.push({ source, asset });
    }
    manifest.models.push({ ...model, unpackedSize: files.reduce((n, f) => n + f.size, 0), files });
  }
  // Verified before anything is written, so a bad archive leaves no partial
  // release directory behind for the next run to trip over.
  const runtimes = runtimeRoot
    ? await readVerifiedRuntimes(runtimeRoot, base)
    : { entries: [], sources: [] };
  if (runtimes.entries.length > 0) manifest.runtimes = runtimes.entries;
  validateManifest(manifest);
  fs.mkdirSync(path.join(outputRoot, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(outputRoot, 'catalog'));
  for (const { source, asset } of [...sources, ...runtimes.sources]) {
    fs.copyFileSync(source, path.join(outputRoot, 'assets', asset));
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(outputRoot, 'catalog/model-manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outputRoot, 'catalog/model-manifest.sig'), crypto.sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString('base64'));
  fs.writeFileSync(path.join(outputRoot, 'catalog/model-manifest-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  return {
    models: manifest.models.length,
    files: sources.length,
    runtimes: runtimes.entries.length,
    outputRoot,
  };
}

module.exports = { prepare };
if (require.main === module) {
  // RUNTIME_DIRECTORY is optional: a models-only release is valid, and the
  // runtime archives are rebuilt far less often than the models change.
  const [modelRoot, outputRoot, baseUrl, runtimeRoot] = process.argv.slice(2);
  if (!modelRoot || !outputRoot || !baseUrl) {
    console.error('Usage: node scripts/prepare-local-model-release.cjs MODEL_ROOT NEW_OUTPUT_DIRECTORY HTTPS_ASSET_DIRECTORY [RUNTIME_DIRECTORY]');
    process.exitCode = 1;
  } else prepare({ modelRoot, outputRoot, baseUrl, runtimeRoot }).then(console.log).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
