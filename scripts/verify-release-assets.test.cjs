const test = require('node:test');
const assert = require('node:assert/strict');
const { assetUrls, verifyReleaseAssets } = require('./verify-release-assets.cjs');

const manifest = {
  schemaVersion: 1,
  runtimeVersion: 'test-v1',
  models: [
    { id: 'whisper-small', files: [
      { path: 'config.json', url: 'https://example.com/r/whisper-small-config.json' },
      { path: 'model.bin', url: 'https://example.com/r/whisper-small-model.bin' },
    ] },
    { id: 'hy-mt2-1.8b', files: [
      { path: 'model.gguf', url: 'https://example.com/r/hy-model.gguf' },
    ] },
  ],
  runtimes: [
    { id: 'openvino-cpu', revision: 'b9940', url: 'https://example.com/r/runtime-cpu.zip' },
  ],
};

/** A fetch stub that answers from a status table and records every call. */
function stubFetch(statuses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, init });
      const answer = statuses[url];
      if (typeof answer === 'function') return answer(init);
      if (answer instanceof Error) throw answer;
      return { status: answer === undefined ? 200 : answer };
    },
  };
}

const allOk = () => Object.fromEntries(assetUrls(manifest).map(t => [t.url, 200]));

test('lists every model file and runtime archive a client would fetch', () => {
  const targets = assetUrls(manifest);
  assert.equal(targets.length, 4);
  assert.deepEqual(targets.map(t => t.label), [
    'whisper-small/config.json',
    'whisper-small/model.bin',
    'hy-mt2-1.8b/model.gguf',
    'runtime openvino-cpu@b9940',
  ]);
});

test('a manifest with no runtimes still checks its model files', async () => {
  const modelsOnly = { ...manifest, runtimes: undefined };
  assert.equal(assetUrls(modelsOnly).length, 3);
  const { fetchImpl } = stubFetch({});
  const result = await verifyReleaseAssets({ manifest: modelsOnly, fetchImpl });
  assert.equal(result.checked, 3);
  assert.ok(result.ok);
});

test('passes when every asset answers 200', async () => {
  const { fetchImpl, calls } = stubFetch(allOk());
  const result = await verifyReleaseAssets({ manifest, fetchImpl });
  assert.deepEqual(result, { checked: 4, failures: [], ok: true });
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.method === 'HEAD'));
});

test('fails and names the first failure in manifest order', async () => {
  // Two failures, and the later one is answered first by the concurrent
  // workers. Reporting has to stay in manifest order to be reproducible.
  const statuses = { ...allOk(),
    'https://example.com/r/whisper-small-model.bin': 404,
    'https://example.com/r/runtime-cpu.zip': 403,
  };
  const { fetchImpl } = stubFetch(statuses);
  const result = await verifyReleaseAssets({ manifest, fetchImpl, concurrency: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.checked, 4);
  assert.deepEqual(result.failures.map(f => [f.label, f.status]), [
    ['whisper-small/model.bin', 404],
    ['runtime openvino-cpu@b9940', 403],
  ]);
});

test('a redirect-only host that refuses HEAD is not reported as broken', async () => {
  // Release downloads commonly redirect to a storage origin, and some origins
  // answer 405 to HEAD. A single-byte ranged GET answering 206 proves the asset
  // is there without pulling gigabytes to find out.
  const statuses = { ...allOk(),
    'https://example.com/r/runtime-cpu.zip': (init) => ({ status: init.method === 'HEAD' ? 405 : 206 }),
  };
  const { fetchImpl, calls } = stubFetch(statuses);
  const result = await verifyReleaseAssets({ manifest, fetchImpl });
  assert.ok(result.ok, 'a 206 answer to the ranged fallback counts as available');
  const ranged = calls.filter(call => call.method === 'GET');
  assert.equal(ranged.length, 1);
  assert.deepEqual(ranged[0].headers, { Range: 'bytes=0-0' });
});

test('a HEAD refusal that stays broken is still a failure', async () => {
  const statuses = { ...allOk(),
    'https://example.com/r/hy-model.gguf': (init) => ({ status: init.method === 'HEAD' ? 405 : 404 }),
  };
  const { fetchImpl } = stubFetch(statuses);
  const result = await verifyReleaseAssets({ manifest, fetchImpl });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures.map(f => [f.label, f.status]), [['hy-mt2-1.8b/model.gguf', 404]]);
});

test('a network error is a failure carrying its reason, not a crash', async () => {
  const statuses = { ...allOk(),
    'https://example.com/r/whisper-small-config.json': new Error('getaddrinfo ENOTFOUND'),
  };
  const { fetchImpl } = stubFetch(statuses);
  const result = await verifyReleaseAssets({ manifest, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].status, 0);
  assert.match(result.failures[0].reason, /ENOTFOUND/);
});

test('checks anonymously, so a draft or private release cannot pass', async () => {
  // A token in the environment would let this gate pass on a release that
  // every real user gets a 404 from.
  const { fetchImpl, calls } = stubFetch(allOk());
  await verifyReleaseAssets({ manifest, fetchImpl });
  for (const call of calls) {
    assert.equal(call.init.credentials, 'omit');
    const headers = call.headers || {};
    const names = Object.keys(headers).map(name => name.toLowerCase());
    assert.ok(!names.includes('authorization'), 'must not send an Authorization header');
    assert.ok(!names.some(name => name.includes('token')), 'must not send a token header');
  }
});

test('follows redirects rather than reporting a 302 as broken', async () => {
  const { fetchImpl, calls } = stubFetch(allOk());
  await verifyReleaseAssets({ manifest, fetchImpl });
  assert.ok(calls.every(call => call.init.redirect === 'follow'));
});
