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

const NODE_TEST_GLOB = 'electron/captions/*.test.cjs';

function vitestArray(name) {
  const match = vitestConfig.match(
    new RegExp(`${name}:\\s*\\[([\\s\\S]*?)\\n\\s*\\],`),
  );
  assert.ok(match, `vitest.config.ts must declare an explicit ${name} array`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

test('the node:test job collects every caption .cjs suite', () => {
  assert.ok(
    packageJson.scripts['test:captions'].includes(NODE_TEST_GLOB),
    `test:captions must run ${NODE_TEST_GLOB}`,
  );
  const suites = fs
    .readdirSync(__dirname)
    .filter((entry) => entry.endsWith('.test.cjs'));
  assert.ok(suites.length > 0, 'expected caption node:test suites to exist');
  assert.ok(
    suites.includes(path.basename(__filename)),
    'this guard must itself run in the node:test job',
  );
});

test('no .cjs suite lives outside the directory the node:test glob covers', () => {
  const stray = [];
  const skip = new Set(['node_modules', '.git', '.claude', 'build', 'out', 'dist-electron']);
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
        if (path.posix.dirname(relative) !== 'electron/captions') {
          stray.push(relative);
        }
      }
    }
  };
  walk(repoRoot);
  assert.deepEqual(
    stray,
    [],
    'a .cjs suite outside electron/captions/ would be run by neither command',
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

test('Vitest collects only caption renderer suites', () => {
  assert.deepEqual(vitestArray('include'), [
    'src/captions/**/*.test.{ts,tsx}',
  ]);
});

test('quarantined legacy suites are excluded rather than silently failing', () => {
  const exclude = vitestArray('exclude');
  for (const quarantined of [
    'electron/better-auth-adapter.test.js',
    'electron/sidecar-bundle.test.js',
  ]) {
    assert.ok(
      exclude.includes(quarantined),
      `${quarantined} tests a subsystem this client does not build and must stay excluded`,
    );
    assert.ok(
      fs.existsSync(path.join(repoRoot, quarantined)),
      `${quarantined} is still on disk; drop the exclusion when the module is removed`,
    );
  }
});
