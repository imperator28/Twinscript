// Confirm the tag being released matches the version that will be built.
//
// Decision logic and its scope rationale live in scripts/release/tag-version.js.
//
// Usage:
//   node scripts/verify-tag-version.mjs v1.2.3
//   node scripts/verify-tag-version.mjs "$GITHUB_REF"
//
// Exits 0 on match, 1 on mismatch, 2 on a usage error.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  checkTagVersion,
  formatTagVersionReport,
} = require('./release/tag-version.js');

// Only the sites this release actually builds from. See the scope note in
// release/tag-version.js for why extension/* is excluded.
const VERSION_FILES = ['package.json', 'package-lock.json'];

function main() {
  const tag = process.argv[2];
  if (!tag) {
    console.error('usage: node scripts/verify-tag-version.mjs <tag>');
    return 2;
  }

  const sites = [];
  for (const name of VERSION_FILES) {
    const file = path.resolve(name);
    if (!fs.existsSync(file)) {
      console.error(`FAIL  ${name} not found`);
      return 2;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      console.error(`FAIL  ${name} is not valid JSON: ${error.message}`);
      return 2;
    }
    sites.push({ name, version: parsed.version });
  }

  const report = checkTagVersion({ tag, sites });
  console.log(`tag: ${tag}`);
  console.log(formatTagVersionReport(report));
  if (!report.ok) {
    console.log('');
    console.log('The release workflow builds the tagged commit verbatim, so the');
    console.log('installer would be published under a version it does not carry.');
    console.log('Re-tag on a commit where these agree - see CLAUDE.md.');
  }
  return report.ok ? 0 : 1;
}

process.exitCode = main();
