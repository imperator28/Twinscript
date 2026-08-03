'use strict';

// Does the tag being released match the version that will be built?
//
// The release workflow checks out a tag verbatim, so a tag placed on a commit
// whose version fields disagree produces an installer whose filename, Squirrel
// RELEASES entry, and update metadata do not match the release it is published
// under. That has happened before in this repository's history; see the version
// update process in CLAUDE.md.
//
// SCOPE: the root package.json and package-lock.json only.
//
// CLAUDE.md documents a five-site parity rule that also covers
// extension/package.json, extension/manifest.json and extension/package-lock.json.
// That rule belongs to the upstream Sokuji release, which ships the browser
// extension. This Windows caption client deliberately does not build or ship
// the extension - see the note at the top of .github/workflows/windows-ci.yml -
// and the extension currently sits at an unrelated upstream version. Requiring
// parity with it here would block every Windows release for a reason that has
// nothing to do with the artifact being shipped.

/** Strip a single leading `v` from a tag ref or tag name. */
function normalizeTag(tag) {
  const name = String(tag || '').replace(/^refs\/tags\//, '').trim();
  return name.replace(/^v/, '');
}

/**
 * Compare a tag against the version sites this release actually ships.
 *
 * @param {object} options
 * @param {string} options.tag Tag name or full ref (`v1.2.3` or `refs/tags/v1.2.3`).
 * @param {Array<{name: string, version: unknown}>} options.sites
 *   One entry per version-bearing file that this release builds from.
 * @returns {{ok: boolean, version: string, mismatches: Array, problems: string[]}}
 */
function checkTagVersion({ tag, sites } = {}) {
  const problems = [];
  const version = normalizeTag(tag);

  if (!version) {
    problems.push('no tag was supplied');
  } else if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    // Squirrel derives filenames and RELEASES entries from the version, so a
    // tag that is not a plain semver is rejected rather than guessed at.
    problems.push(`tag '${tag}' is not a vMAJOR.MINOR.PATCH version`);
  }

  const list = Array.isArray(sites) ? sites : [];
  if (!list.length) problems.push('no version sites were supplied to compare');

  const mismatches = [];
  for (const site of list) {
    const found = site?.version;
    if (typeof found !== 'string' || !found.trim()) {
      mismatches.push({ name: site?.name ?? '(unnamed)', expected: version, found: null });
      continue;
    }
    if (found.trim() !== version) {
      mismatches.push({ name: site.name, expected: version, found: found.trim() });
    }
  }

  return {
    ok: problems.length === 0 && mismatches.length === 0,
    version,
    mismatches,
    problems,
  };
}

/** Human-readable lines for CI output. */
function formatTagVersionReport(report) {
  const lines = [];
  for (const problem of report.problems) lines.push(`  FAIL  ${problem}`);
  for (const m of report.mismatches) {
    lines.push(
      `  FAIL  ${m.name}: expected ${m.expected}, found ${m.found ?? '(missing or not a string)'}`,
    );
  }
  if (report.ok) lines.push(`  OK    every version site reads ${report.version}`);
  return lines.join('\n');
}

module.exports = { checkTagVersion, formatTagVersionReport, normalizeTag };
