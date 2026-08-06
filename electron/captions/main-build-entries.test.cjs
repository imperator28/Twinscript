// Every sibling-required main-process module must be a declared build entry.
//
// vite.config.ts marks sibling requires external:
//
//     /^\.\/[a-z0-9-]+$/
//
// which is deliberate - rolldown otherwise inlines the target entry and leaves a
// re-export stub that mangles CJS exports. The consequence is that a `require('./x')`
// survives into dist-electron verbatim, so if `x` is not also listed as an entry the
// file is never emitted and the app dies at launch with
// "Cannot find module './x'".
//
// Nothing else catches this. `npm run build` succeeds, both test suites pass, and the
// failure appears only when the packaged main process is actually loaded - which is
// exactly how it shipped: a new module was added, required from a sibling, and the
// crash showed up in a dialog on the next launch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const CAPTIONS_DIR = __dirname;
const CONFIG_PATH = path.join(CAPTIONS_DIR, '..', '..', 'vite.config.ts');

/** Entry targets under electron/captions, as module basenames. */
function declaredEntries() {
  const config = fs.readFileSync(CONFIG_PATH, 'utf8');
  const entries = new Set();
  for (const [, name] of config.matchAll(
    /'electron\/captions\/([a-z0-9-]+)\.js'/g,
  )) {
    entries.add(name);
  }
  return entries;
}

/** Non-test main-process sources in this directory. */
function sourceFiles() {
  return fs
    .readdirSync(CAPTIONS_DIR)
    .filter((name) => name.endsWith('.js') && !name.includes('.test.'));
}

/** Map of module basename -> the files that require it as a sibling. */
function siblingRequires() {
  const graph = new Map();
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(path.join(CAPTIONS_DIR, file), 'utf8');
    for (const [, target] of source.matchAll(
      /require\(\s*['"]\.\/([a-z0-9-]+)['"]\s*\)/g,
    )) {
      if (!graph.has(target)) graph.set(target, []);
      graph.get(target).push(file);
    }
  }
  return graph;
}

test('the external regex in vite.config still matches sibling requires', () => {
  // If this pattern changes, the rest of this file is testing the wrong invariant.
  const config = fs.readFileSync(CONFIG_PATH, 'utf8');
  assert.match(
    config,
    /\/\^\\\.\\\/\[a-z0-9-\]\+\$\//,
    'expected the sibling-external pattern /^\\.\\/[a-z0-9-]+$/ in vite.config.ts',
  );
});

test('every sibling-required module is a declared build entry', () => {
  const entries = declaredEntries();
  const missing = [];
  for (const [target, requiredBy] of siblingRequires()) {
    if (!entries.has(target)) {
      missing.push(`  ./${target}  required by ${requiredBy.join(', ')}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    'These modules are required as siblings but are not build entries, so they will ' +
      'not be emitted to dist-electron and the main process will fail to load:\n' +
      `${missing.join('\n')}\n` +
      "Add each to the `entry` map in vite.config.ts as " +
      "'captions/<name>': 'electron/captions/<name>.js'.",
  );
});

test('every declared entry points at a file that exists', () => {
  // The other direction: a renamed or deleted module leaves a dangling entry, and
  // rolldown fails late with a resolution error rather than naming the config.
  const present = new Set(sourceFiles().map((name) => name.replace(/\.js$/, '')));
  const dangling = [...declaredEntries()].filter((name) => !present.has(name));
  assert.deepEqual(dangling, [], `entries with no source file: ${dangling.join(', ')}`);
});

test('pending-audio-retention is wired in, the case that actually broke', () => {
  const entries = declaredEntries();
  assert.ok(
    entries.has('pending-audio-retention'),
    'meeting-record-controller requires it as a sibling',
  );
});
