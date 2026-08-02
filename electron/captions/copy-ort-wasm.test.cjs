const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  copyOrtWasm,
  FILES,
  SRC,
  DEST,
} = require('../../scripts/copy-ort-wasm.cjs');

const silentLogger = { info() {}, warn() {} };

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'copy-ort-wasm-'));
}

test('a missing onnxruntime-web install skips instead of failing', () => {
  const cwd = makeWorkspace();
  try {
    const result = copyOrtWasm({ cwd, logger: silentLogger });
    assert.equal(result.skipped, true);
    assert.equal(fs.existsSync(path.join(cwd, DEST)), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('every declared runtime file is copied into the public asset directory', () => {
  const cwd = makeWorkspace();
  try {
    const srcDir = path.join(cwd, SRC);
    fs.mkdirSync(srcDir, { recursive: true });
    for (const file of FILES) {
      fs.writeFileSync(path.join(srcDir, file), `contents of ${file}`);
    }

    const result = copyOrtWasm({ cwd, logger: silentLogger });

    assert.equal(result.skipped, false);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.copied, FILES);
    for (const file of FILES) {
      assert.equal(
        fs.readFileSync(path.join(cwd, DEST, file), 'utf8'),
        `contents of ${file}`,
      );
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('an absent runtime file is reported without aborting the copy', () => {
  const cwd = makeWorkspace();
  const warnings = [];
  try {
    const srcDir = path.join(cwd, SRC);
    fs.mkdirSync(srcDir, { recursive: true });
    const [absent, ...present] = FILES;
    for (const file of present) {
      fs.writeFileSync(path.join(srcDir, file), file);
    }

    const result = copyOrtWasm({
      cwd,
      logger: { info() {}, warn: (message) => warnings.push(message) },
    });

    assert.deepEqual(result.missing, [absent]);
    assert.deepEqual(result.copied, present);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /not found/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('an existing stale copy is overwritten by the installed runtime', () => {
  const cwd = makeWorkspace();
  try {
    const srcDir = path.join(cwd, SRC);
    const destDir = path.join(cwd, DEST);
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(destDir, { recursive: true });
    for (const file of FILES) {
      fs.writeFileSync(path.join(srcDir, file), 'fresh');
      fs.writeFileSync(path.join(destDir, file), 'stale');
    }

    copyOrtWasm({ cwd, logger: silentLogger });

    for (const file of FILES) {
      assert.equal(fs.readFileSync(path.join(destDir, file), 'utf8'), 'fresh');
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a directory shadowing a runtime filename is not copied', () => {
  const cwd = makeWorkspace();
  try {
    const srcDir = path.join(cwd, SRC);
    fs.mkdirSync(path.join(srcDir, FILES[0]), { recursive: true });

    const result = copyOrtWasm({ cwd, logger: silentLogger });

    assert.ok(result.missing.includes(FILES[0]));
    assert.equal(fs.existsSync(path.join(cwd, DEST, FILES[0])), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
