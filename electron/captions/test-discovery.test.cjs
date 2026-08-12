// Guards the W0 test-runner split: Vitest owns caption renderer suites and
// `node --test` owns caption main-process suites. Upstream Sokuji suites must
// not gate this product. Both commands must exit 0 for the Windows W0 gate.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
);
const vitestConfig = fs.readFileSync(
  path.join(repoRoot, 'vitest.config.ts'),
  'utf8',
);

// Every directory the `node --test` job collects from. Widening this list is a
// deliberate act: a .cjs suite in a directory not listed here is run by neither
// runner and would fail silently, which is what the second test below catches.
const NODE_TEST_GLOBS = Object.freeze([
  'electron/captions/*.test.cjs',
  'native/local-inference-host/tests/*.test.cjs',
  'scripts/*.test.cjs',
  'scripts/release/*.test.cjs',
]);
const NODE_TEST_DIRS = Object.freeze(
  NODE_TEST_GLOBS.map((glob) => path.posix.dirname(glob)),
);

function vitestArray(name) {
  const match = vitestConfig.match(
    new RegExp(`${name}:\\s*\\[([\\s\\S]*?)\\n\\s*\\],`),
  );
  assert.ok(match, `vitest.config.ts must declare an explicit ${name} array`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

test('the node:test job collects every caption .cjs suite', () => {
  for (const glob of NODE_TEST_GLOBS) {
    assert.ok(
      packageJson.scripts['test:captions'].includes(glob),
      `test:captions must run ${glob}`,
    );
  }
  const suites = fs
    .readdirSync(__dirname)
    .filter((entry) => entry.endsWith('.test.cjs'));
  assert.ok(suites.length > 0, 'expected caption node:test suites to exist');
  assert.ok(
    suites.includes(path.basename(__filename)),
    'this guard must itself run in the node:test job',
  );
});

test('every directory the node:test job globs actually holds a suite', () => {
  // A glob that matches nothing makes `node --test` fail on the unmatched
  // pattern, so an emptied directory must be removed from the list too.
  for (const dir of NODE_TEST_DIRS) {
    const absolute = path.join(repoRoot, dir);
    assert.ok(fs.existsSync(absolute), `${dir} is globbed but does not exist`);
    const suites = fs
      .readdirSync(absolute)
      .filter((entry) => entry.endsWith('.test.cjs'));
    assert.ok(suites.length > 0, `${dir} is globbed but holds no .test.cjs suite`);
  }
});

test('no .cjs suite lives outside the directory the node:test glob covers', () => {
  const stray = [];
  // `.claude/` and `.worktrees/` hold gitignored worktree checkouts of other
  // branches. Their stale test copies are not part of this tree's discovery and
  // would otherwise be reported as suites no runner owns.
  const skip = new Set([
    'node_modules',
    '.git',
    '.claude',
    '.worktrees',
    '.superpowers',
    'build',
    'out',
    'dist-electron',
  ]);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith('.test.cjs')) {
        const relative = path
          .relative(repoRoot, path.join(dir, entry.name))
          .split(path.sep)
          .join('/');
        if (!NODE_TEST_DIRS.includes(path.posix.dirname(relative))) {
          stray.push(relative);
        }
      }
    }
  };
  walk(repoRoot);
  assert.deepEqual(
    stray,
    [],
    `a .cjs suite outside ${NODE_TEST_DIRS.join(', ')} would be run by neither command`,
  );
});

test('Vitest discovery never reaches the node:test suites', () => {
  const include = vitestArray('include');
  assert.ok(include.length > 0, 'expected an explicit Vitest include list');
  for (const pattern of include) {
    assert.ok(
      !pattern.includes('cjs'),
      `Vitest include pattern must not match .cjs files: ${pattern}`,
    );
  }
});

test('Vitest does not gate this client on the upstream browser extension', () => {
  const include = vitestArray('include');
  assert.ok(
    include.every((pattern) => !pattern.startsWith('extension/')),
    'extension/ is a separate upstream product and must not gate the caption build',
  );
});

test('Vitest collects the caption surfaces and the live capture path, nothing else', () => {
  // Two entries, both deliberate. `src/lib/modern-audio` was added after a
  // deleted AudioWorklet reached a meeting: the capture path is live product code
  // and had no coverage at all, so nothing failed when its worklet disappeared.
  assert.deepEqual(vitestArray('include'), [
    'src/captions/**/*.test.{ts,tsx}',
    'src/lib/modern-audio/**/*.test.{ts,tsx}',
  ]);
});

test('Vitest does not collect the retained local-inference stack', () => {
  // The point of pinning the include list: src/lib/local-inference is kept
  // deliberately but nothing in the app reaches it, and its suites must never
  // gate this product. Widening to all of src/lib would silently do that.
  for (const pattern of vitestArray('include')) {
    assert.ok(
      !pattern.includes('local-inference'),
      `${pattern} pulls in the retained local-inference suites`,
    );
    assert.ok(
      !/^src\/lib\/\*/.test(pattern),
      `${pattern} is broad enough to reach local-inference; name the subdirectory`,
    );
  }
});

test('the legacy quarantine is gone, not just unenforced', () => {
  // This used to assert that electron/better-auth-adapter.test.js and
  // electron/sidecar-bundle.test.js stayed in Vitest's exclude list, with a note
  // to "drop the exclusion when the module is removed". They are now removed, so
  // the assertion is inverted: the files must be gone AND absent from the exclude
  // list, because a stale exclusion is how that list silently accumulates paths
  // nobody can explain.
  const exclude = vitestArray('exclude');
  for (const removed of [
    'electron/better-auth-adapter.test.js',
    'electron/sidecar-bundle.test.js',
  ]) {
    assert.equal(
      fs.existsSync(path.join(repoRoot, removed)),
      false,
      `${removed} is back; decide deliberately whether it should run`,
    );
    assert.ok(
      !exclude.includes(removed),
      `${removed} no longer exists, so excluding it is dead configuration`,
    );
  }
});
