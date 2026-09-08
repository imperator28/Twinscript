// Guard the signed catalog that ships inside the installer.
//
// These three files are what turn the Install buttons in Settings from decoration
// into something that works. They are committed rather than generated at package
// time so that a clean clone builds an installer identical to this machine's, and
// that only holds while something checks they are actually there and actually
// verify. A missing or unsigned catalog is invisible until an operator clicks
// Install and gets nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadManifest } = require('../electron/captions/local-model-manifest');

const catalogRoot = path.join(__dirname, '..', 'resources', 'local-models');
const read = (name) => fs.readFileSync(path.join(catalogRoot, name), 'utf8');

test('the signed catalog ships with the three files a client needs', () => {
  for (const name of ['model-manifest.json', 'model-manifest.sig', 'model-manifest-public.pem']) {
    assert.ok(fs.existsSync(path.join(catalogRoot, name)), `missing ${name}`);
  }
});

test('no private signing material sits beside the catalog', () => {
  // The signing key is what authorises every future manifest. It is generated
  // per release and must never reach the repository or an installer.
  const unexpected = fs.readdirSync(catalogRoot).filter(name => !new Set([
    'model-manifest.json', 'model-manifest.sig', 'model-manifest-public.pem', 'README.md',
  ]).has(name));
  assert.deepEqual(unexpected, [], `unexpected files in the catalog directory: ${unexpected.join(', ')}`);
  assert.doesNotMatch(read('model-manifest-public.pem'), /PRIVATE KEY/);
});

test('the committed manifest verifies against the committed public key', () => {
  // `packaged: true` is the same path the app takes at runtime, so this fails
  // here for exactly the reasons it would fail on a user's machine.
  const manifest = loadManifest({
    json: read('model-manifest.json'),
    signature: read('model-manifest.sig'),
    publicKey: read('model-manifest-public.pem'),
    packaged: true,
  });
  assert.ok(manifest.models.length > 0, 'a catalog with no models cannot install anything');
});

test('a tampered manifest is refused', () => {
  // Proves the signature is load-bearing rather than decorative.
  const tampered = JSON.parse(read('model-manifest.json'));
  tampered.models[0].files[0].size += 1;
  assert.throws(() => loadManifest({
    json: JSON.stringify(tampered),
    signature: read('model-manifest.sig'),
    publicKey: read('model-manifest-public.pem'),
    packaged: true,
  }));
});

test('every asset URL is HTTPS with a hostname and no credentials', () => {
  const manifest = JSON.parse(read('model-manifest.json'));
  const urls = [
    ...manifest.models.flatMap(model => model.files.map(file => file.url)),
    ...(manifest.runtimes || []).map(runtime => runtime.url),
  ];
  assert.ok(urls.length > 0);
  for (const value of urls) {
    const url = new URL(value);
    assert.equal(url.protocol, 'https:', `not HTTPS: ${value}`);
    assert.ok(url.hostname, `no hostname: ${value}`);
    assert.equal(url.username, '', `credentials in URL: ${value}`);
    assert.equal(url.password, '', `credentials in URL: ${value}`);
    assert.equal(url.hash, '', `fragment in URL: ${value}`);
  }
});

test('the catalog offers the runtime the required pipeline cannot start without', () => {
  // A catalog that lists models but no runtime is the failure this release was
  // meant to fix: the models download, and then nothing can execute them.
  const manifest = JSON.parse(read('model-manifest.json'));
  const runtimes = manifest.runtimes || [];
  assert.ok(runtimes.length > 0, 'the catalog advertises no runtime archives');
  const cpu = runtimes.find(runtime => runtime.family === 'cpu');
  assert.ok(cpu, 'the required CPU/NPU runtime is missing from the catalog');
  // CUDA is optional, but a CUDA entry built from a different revision than the
  // CPU one would mix two runtime trees on disk.
  const cuda = runtimes.find(runtime => runtime.family === 'cuda');
  if (cuda) assert.equal(cuda.revision, cpu.revision);
});
