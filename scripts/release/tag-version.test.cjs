'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  checkTagVersion,
  formatTagVersionReport,
  normalizeTag,
} = require('./tag-version.js');

const site = (name, version) => ({ name, version });

test('normalizeTag accepts a bare tag, a v-prefix, and a full ref', () => {
  assert.equal(normalizeTag('1.2.3'), '1.2.3');
  assert.equal(normalizeTag('v1.2.3'), '1.2.3');
  assert.equal(normalizeTag('refs/tags/v1.2.3'), '1.2.3');
  assert.equal(normalizeTag('  v1.2.3  '), '1.2.3');
});

test('normalizeTag strips only one leading v', () => {
  assert.equal(normalizeTag('vv1.2.3'), 'v1.2.3');
});

test('a matching tag and version sites pass', () => {
  const report = checkTagVersion({
    tag: 'v1.2.3',
    sites: [site('package.json', '1.2.3'), site('package-lock.json', '1.2.3')],
  });
  assert.equal(report.ok, true);
  assert.equal(report.version, '1.2.3');
  assert.deepEqual(report.mismatches, []);
});

test('a lagging lockfile fails, naming the file', () => {
  const report = checkTagVersion({
    tag: 'v1.2.3',
    sites: [site('package.json', '1.2.3'), site('package-lock.json', '1.2.2')],
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.mismatches, [
    { name: 'package-lock.json', expected: '1.2.3', found: '1.2.2' },
  ]);
  assert.match(formatTagVersionReport(report), /package-lock\.json: expected 1\.2\.3, found 1\.2\.2/);
});

test('a missing version is a mismatch, not a pass', () => {
  for (const bad of [undefined, null, '', '   ', 42, {}]) {
    const report = checkTagVersion({
      tag: 'v1.2.3',
      sites: [site('package.json', bad)],
    });
    assert.equal(report.ok, false, `${JSON.stringify(bad)} must not pass`);
    assert.equal(report.mismatches[0].found, null);
  }
});

test('no sites supplied fails instead of vacuously passing', () => {
  assert.equal(checkTagVersion({ tag: 'v1.2.3', sites: [] }).ok, false);
  assert.equal(checkTagVersion({ tag: 'v1.2.3' }).ok, false);
  assert.match(
    formatTagVersionReport(checkTagVersion({ tag: 'v1.2.3', sites: [] })),
    /no version sites/,
  );
});

test('a missing tag fails', () => {
  const report = checkTagVersion({ tag: '', sites: [site('package.json', '1.2.3')] });
  assert.equal(report.ok, false);
  assert.match(report.problems.join(' '), /no tag was supplied/);
});

test('a non-semver tag is rejected rather than guessed at', () => {
  for (const bad of ['vlatest', 'v1.2', 'v1', 'release-1.2.3', 'v1.2.3.4']) {
    const report = checkTagVersion({
      tag: bad,
      sites: [site('package.json', '1.2.3')],
    });
    assert.equal(report.ok, false, `${bad} must be rejected`);
  }
});

test('a prerelease tag is accepted', () => {
  const report = checkTagVersion({
    tag: 'v1.2.3-rc.1',
    sites: [site('package.json', '1.2.3-rc.1')],
  });
  assert.equal(report.ok, true);
});

test('whitespace in a version field does not cause a false mismatch', () => {
  const report = checkTagVersion({
    tag: 'v1.2.3',
    sites: [site('package.json', ' 1.2.3 ')],
  });
  assert.equal(report.ok, true);
});

test('extension version sites are deliberately outside this check', () => {
  // The extension is a separate upstream product at an unrelated version and is
  // not built by the Windows release. If it were included, this repository could
  // not release at all today. Pinned so the exclusion stays a decision rather
  // than drifting into an oversight.
  const repoRoot = path.resolve(__dirname, '..', '..');
  const readVersion = (rel) =>
    JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8')).version;

  const rootVersion = readVersion('package.json');
  const extensionVersion = readVersion('extension/package.json');
  assert.notEqual(
    rootVersion,
    extensionVersion,
    'if these ever match, re-read the scope note in tag-version.js before relying on it',
  );

  const report = checkTagVersion({
    tag: `v${rootVersion}`,
    sites: [
      site('package.json', rootVersion),
      site('package-lock.json', readVersion('package-lock.json')),
    ],
  });
  assert.equal(
    report.ok,
    true,
    'the current tree must be releasable at its own version',
  );
});
