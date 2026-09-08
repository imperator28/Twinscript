// Check that every asset a signed catalog points at is actually downloadable.
//
// This exists because a release can be perfectly signed and still be useless:
// the catalog is generated before the release is published, so its URLs are
// predictions. When they are wrong the client does everything right and still
// fails, and the operator sees a download that never starts with nothing to
// act on. Cheap to check here, expensive to discover after shipping.
//
// Every request is anonymous on purpose. A token in the environment would let
// a private or draft release pass this gate and then 404 for every real user,
// which is the exact failure it is meant to catch.
const fs = require('node:fs');
const path = require('node:path');

const REDIRECT_LIMIT = 5;

/** Every URL a client would fetch, labelled so a failure names the thing that broke. */
function assetUrls(manifest) {
  const urls = [];
  for (const model of manifest.models || []) {
    for (const file of model.files || []) {
      urls.push({ label: `${model.id}/${file.path}`, url: file.url });
    }
  }
  for (const runtime of manifest.runtimes || []) {
    urls.push({ label: `runtime ${runtime.id}@${runtime.revision}`, url: runtime.url });
  }
  return urls;
}

/**
 * Resolve one URL to a final status.
 *
 * Release hosts redirect downloads to a storage origin, so redirects are
 * followed and the final status is what counts. Some hosts refuse HEAD; a
 * single-byte ranged GET is the fallback, since downloading the asset to prove
 * it exists would mean pulling gigabytes per check.
 */
async function resolveStatus(url, fetchImpl) {
  const request = (method, headers) => fetchImpl(url, {
    method,
    headers,
    redirect: 'follow',
    // No credentials, ever: see the note at the top of this file.
    credentials: 'omit',
  });
  let response = await request('HEAD');
  if (response.status === 405 || response.status === 501) {
    response = await request('GET', { Range: 'bytes=0-0' });
    // A ranged GET that the host honoured answers 206, not 200.
    if (response.status === 206) return 200;
  }
  return response.status;
}

/**
 * HEAD every asset URL in a manifest.
 *
 * Resolves to the full picture rather than throwing on the first failure, so
 * one run tells the operator everything that needs fixing. `ok` is the value
 * the exit code is derived from.
 */
async function verifyReleaseAssets({ manifest, fetchImpl = globalThis.fetch, concurrency = 6 } = {}) {
  const targets = assetUrls(manifest);
  const failures = [];
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const target = targets[next++];
      let status;
      try {
        status = await resolveStatus(target.url, fetchImpl);
      } catch (error) {
        failures.push({ ...target, status: 0, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (status !== 200) failures.push({ ...target, status });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  // Reported in manifest order rather than completion order, so the first
  // failure named is stable between runs.
  const order = new Map(targets.map((target, index) => [target.url, index]));
  failures.sort((a, b) => order.get(a.url) - order.get(b.url));
  return { checked: targets.length, failures, ok: failures.length === 0 };
}

function readManifest(manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

module.exports = { assetUrls, verifyReleaseAssets, readManifest };

if (require.main === module) {
  const manifestPath = process.argv[2]
    || path.join(__dirname, '..', 'resources', 'local-models', 'model-manifest.json');
  verifyReleaseAssets({ manifest: readManifest(manifestPath) })
    .then(({ checked, failures, ok }) => {
      if (ok) {
        console.log(`All ${checked} release assets are downloadable.`);
        return;
      }
      const [first] = failures;
      console.error(`${failures.length} of ${checked} release assets are not downloadable.`);
      console.error(`First failure: ${first.label} -> HTTP ${first.status}${first.reason ? ` (${first.reason})` : ''}`);
      console.error(`  ${first.url}`);
      for (const failure of failures.slice(1)) {
        console.error(`  HTTP ${failure.status}  ${failure.label}`);
      }
      process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
