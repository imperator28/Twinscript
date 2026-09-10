const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { LocalRuntimeManager, validateArchivePath, extractRuntimeArchive } = require('./local-runtime-manager');

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-manager-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = Buffer.from('runtime archive');
  // `unpackedSize` is declared because a real catalog always carries it -
  // `validateManifest` refuses a runtime entry without a positive integer there,
  // so a manager can never see one. Omitting it here was not a harmless
  // shortcut: the installer's free-space estimate falls back to
  // MAX_EXPANDED_BYTES (24 GB) per tree, which for CUDA means 48 GB, so whether
  // these tests passed depended on how much disk the machine happened to have.
  // A developer box has it and a CI runner does not, which is why the CUDA
  // precondition test failed with "Insufficient free disk space" instead of the
  // "install the CPU runtime first" it asserts.
  const runtimes = ['openvino-cpu', 'cuda'].map(id => ({ id, family: id === 'cuda' ? 'cuda' : 'cpu', revision: 'r1', url: 'https://example.com/runtime.zip', size: data.length, unpackedSize: 4096, sha256: crypto.createHash('sha256').update(data).digest('hex') }));
  const manager = new LocalRuntimeManager({ root, runtimes, fetchImpl: async () => new Response(data), verifyRuntime: async executable => {
    return (await fs.readFile(executable, 'utf8')) === 'host';
  }, extractArchive: async (_archive, stage, { runtime }) => {
    await fs.writeFile(path.join(stage, 'twinscript-local-inference.exe'), 'host');
    await fs.writeFile(path.join(stage, 'runtime-manifest.json'), JSON.stringify({ runtimeFamilies: { cpu: { revision: 'r1' }, ...(runtime.family === 'cuda' ? { cuda: { revision: 'r1' } } : {}) } }));
    if (runtime.family === 'cuda') { await fs.mkdir(path.join(stage, 'llama/cuda'), { recursive: true }); await fs.writeFile(path.join(stage, 'llama/cuda/library.dll'), 'cuda'); }
  }, ...overrides });
  return { manager, root, data };
}

test('installs base then CUDA and removes CUDA without removing CPU', async t => {
  const { manager, root } = await fixture(t);
  assert.equal(manager.status()['openvino-cpu'].state, 'not-installed');
  await assert.rejects(manager.install('cuda'), /CPU/);
  await manager.install('openvino-cpu');
  assert.equal(manager.status()['openvino-cpu'].state, 'ready');
  assert.equal(manager.status()['openvino-cpu'].phase, 'ready');
  assert.equal(manager.status()['openvino-cpu'].family, 'cpu');
  assert.equal(manager.status()['openvino-cpu'].ready, true);
  await manager.install('cuda');
  assert.equal(manager.status().cuda.state, 'ready');
  await manager.remove('cuda');
  assert.equal(manager.status().cuda.state, 'not-installed');
  assert.equal(manager.status()['openvino-cpu'].state, 'ready');
  assert.equal(await fs.readFile(path.join(root, 'r1/twinscript-local-inference.exe'), 'utf8'), 'host');
});

test('bad archive hash never extracts and preserves installed runtime', async t => {
  const { manager, root } = await fixture(t);
  await manager.install('openvino-cpu');
  manager.fetchImpl = async () => new Response(Buffer.from('corrupt archive'));
  await fs.rm(path.join(root, '.downloads'), { recursive: true, force: true });
  await assert.rejects(manager.install('openvino-cpu'), /hash|size/i);
  assert.equal(await fs.readFile(path.join(root, 'r1/twinscript-local-inference.exe'), 'utf8'), 'host');
});

test('failed staged verification preserves previous installation', async t => {
  const { manager, root } = await fixture(t);
  await manager.install('openvino-cpu');
  manager.extractArchive = async (_archive, stage) => fs.writeFile(path.join(stage, 'twinscript-local-inference.exe'), 'bad');
  await assert.rejects(manager.install('openvino-cpu'), /verif/i);
  assert.equal(await fs.readFile(path.join(root, 'r1/twinscript-local-inference.exe'), 'utf8'), 'host');
});

test('session guard and manager-wide mutation lock reject changes', async t => {
  const { manager } = await fixture(t, { sessionActive: () => true });
  await assert.rejects(manager.install('openvino-cpu'), /meeting/i);
  manager.sessionActive = () => false;
  manager.fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const pending = manager.install('openvino-cpu');
  await assert.rejects(manager.remove('cuda'), /active operation/i);
  manager.cancel('openvino-cpu');
  await assert.rejects(pending);
});

test('rejects unsafe Windows archive entry paths', () => {
  for (const value of ['../x', '/x', 'C:/x', 'a\\b', 'a:stream', 'CON.txt', 'x/aux', 'x./file', 'x//file']) assert.throws(() => validateArchivePath(value), /unsafe/i, value);
  assert.equal(validateArchivePath('llama/cpu/server.exe'), 'llama/cpu/server.exe');
});

test('resumes a partial download with validated content range', async t => {
  const { manager, root, data } = await fixture(t);
  const runtime = manager.runtime('openvino-cpu');
  await fs.mkdir(path.join(root, '.downloads'));
  await fs.writeFile(path.join(root, '.downloads', `${runtime.id}-${runtime.sha256}.zip.partial`), data.subarray(0, 4));
  manager.fetchImpl = async (_url, options) => {
    assert.equal(options.headers.Range, 'bytes=4-');
    return new Response(data.subarray(4), { status: 206, headers: { 'content-range': `bytes 4-${data.length - 1}/${data.length}` } });
  };
  await manager.install(runtime.id);
  assert.equal(manager.status()[runtime.id].state, 'ready');
});

test('real Windows extractor rejects traversal before extracting safe entries', { skip: process.platform !== 'win32' }, async t => {
  const { root } = await fixture(t);
  const archive = path.join(root, 'unsafe.zip');
  const stage = path.join(root, 'stage');
  await fs.mkdir(stage);
  const script = `$ProgressPreference = 'SilentlyContinue'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [IO.Compression.ZipFile]::Open($env:TEST_RUNTIME_ZIP, 'Create'); $z.CreateEntry('safe.txt') | Out-Null; $z.CreateEntry('../escape.txt') | Out-Null; $z.Dispose()`;
  require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, env: { ...process.env, TEST_RUNTIME_ZIP: archive } });
  await assert.rejects(extractRuntimeArchive(archive, stage, { signal: new AbortController().signal }), /Unsafe archive path/);
  assert.deepEqual(await fs.readdir(stage), []);
});

test('HTTP 404 has an actionable runtime download error', async t => {
  const { manager } = await fixture(t, { fetchImpl: async () => new Response('', { status: 404 }) });
  await assert.rejects(manager.install('openvino-cpu'), { code: 'runtime_download_failed' });
  assert.match(manager.status()['openvino-cpu'].error.message, /404/);
});

test('download timeout aborts its network request', async t => {
  const { manager } = await fixture(t, { timeoutMs: 20, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  await assert.rejects(manager.install('openvino-cpu'), { code: 'runtime_timeout' });
  assert.equal(manager.operation, null);
});

test('a cancelled streamed download retains bytes and can resume', async t => {
  const { manager, data } = await fixture(t);
  let notified;
  const started = new Promise(resolve => { notified = resolve; });
  manager.onProgress = progress => { if (progress.downloadedBytes === 4) notified(); };
  manager.fetchImpl = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(data.subarray(0, 4)); } }));
  const pending = manager.install('openvino-cpu');
  await started;
  manager.cancel('openvino-cpu');
  await assert.rejects(pending);
  manager.fetchImpl = async (_url, { headers }) => {
    const offset = Number(headers.Range?.match(/\d+/)?.[0] || 0);
    return new Response(data.subarray(offset), { status: offset ? 206 : 200, headers: offset ? { 'content-range': `bytes ${offset}-${data.length - 1}/${data.length}` } : {} });
  };
  await manager.install('openvino-cpu');
  assert.equal(manager.status()['openvino-cpu'].ready, true);
});

test('a successful install leaves no archive behind', async t => {
  // The archive was kept forever after a good install. Harmless-looking at 71 MB
  // for the CPU runtime, 639 MB for CUDA, and again for every future revision.
  const { manager, root } = await fixture(t);
  await manager.install('openvino-cpu');
  assert.equal(manager.status()['openvino-cpu'].state, 'ready');
  const downloads = path.join(root, '.downloads');
  const left = await fs.readdir(downloads).catch(() => []);
  assert.deepEqual(left, [], `archive retained after a successful install: ${left.join(', ')}`);
  // The installed tree is what survives, not the thing it was built from.
  assert.equal(await fs.readFile(path.join(root, 'r1/twinscript-local-inference.exe'), 'utf8'), 'host');
});

test('cleaning up the archive does not disturb another runtime\'s resumable partial', async t => {
  // Installing the CPU runtime must not delete a half-downloaded CUDA archive:
  // that partial is the only reason the next CUDA attempt resumes rather than
  // restarting a 639 MB download.
  const { manager, root, data } = await fixture(t);
  const downloads = path.join(root, '.downloads');
  await fs.mkdir(downloads, { recursive: true });
  const cuda = manager.runtimes.find(r => r.family === 'cuda');
  const partial = path.join(downloads, `${cuda.id}-${cuda.sha256}.zip.partial`);
  await fs.writeFile(partial, data.subarray(0, 4));

  await manager.install('openvino-cpu');

  assert.equal((await fs.stat(partial)).size, 4, 'the unrelated partial must survive');
  const left = await fs.readdir(downloads);
  assert.deepEqual(left, [path.basename(partial)]);
});
