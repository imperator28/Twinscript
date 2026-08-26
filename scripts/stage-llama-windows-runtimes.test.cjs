const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const scriptsDirectory = __dirname;
const lockPath = path.join(scriptsDirectory, 'llama-windows-runtime-lock.json');
const stagerPath = path.join(scriptsDirectory, 'stage-llama-windows-runtimes.ps1');
const powershellAvailable = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0']).status === 0;
const cpuArchiveName = 'llama-b9940-bin-win-cpu-x64.zip';
const cudaArchiveName = 'llama-b9940-bin-win-cuda-12.4-x64.zip';
const cudartArchiveName = 'cudart-llama-bin-win-cuda-12.4-x64.zip';

const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const sha256Contents = (contents) => crypto.createHash('sha256').update(contents).digest('hex');
const psLiteral = (value) => `'${value.replace(/'/g, "''")}'`;

function createZip(sourceDirectory, zipPath) {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    'Add-Type -AssemblyName System.IO.Compression',
    `[System.IO.Compression.ZipFile]::CreateFromDirectory(${psLiteral(sourceDirectory)}, ${psLiteral(zipPath)})`,
  ].join('; ');
  const result = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function appendZipEntry(zipPath, entryName, contents) {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    'Add-Type -AssemblyName System.IO.Compression',
    `$stream = [System.IO.File]::Open(${psLiteral(zipPath)}, [System.IO.FileMode]::Open)`,
    '$zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Update, $false)',
    `$entry = $zip.CreateEntry(${psLiteral(entryName)})`,
    '$writer = New-Object System.IO.StreamWriter($entry.Open())',
    `$writer.Write(${psLiteral(contents)})`,
    '$writer.Dispose(); $zip.Dispose(); $stream.Dispose()',
  ].join('; ');
  const result = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function zipEntryNames(zipPath) {
  const command = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$zip = [System.IO.Compression.ZipFile]::OpenRead(${psLiteral(zipPath)})`,
    '$zip.Entries | ForEach-Object { $_.FullName }',
    '$zip.Dispose()',
  ].join('; ');
  const result = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
}

function writeFixtureArchive(root, name, files) {
  const sourceDirectory = path.join(root, `${name}-source`);
  const zipPath = path.join(root, name);
  fs.mkdirSync(sourceDirectory, { recursive: true });
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(sourceDirectory, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }
  createZip(sourceDirectory, zipPath);
  return zipPath;
}

function writeFixtureLock(root, archives, hashOverrides = {}) {
  const lock = {
    schemaVersion: 1,
    revision: 'b9940',
    cpu: {
      directory: 'cpu',
      archives: [{
        url: `https://github.com/ggml-org/llama.cpp/releases/download/b9940/${cpuArchiveName}`,
        sha256: hashOverrides.cpu || sha256(archives.cpu),
      }],
    },
    cuda: {
      directory: 'cuda',
      archives: [
        {
          url: `https://github.com/ggml-org/llama.cpp/releases/download/b9940/${cudaArchiveName}`,
          sha256: hashOverrides.cuda || sha256(archives.cuda),
        },
        {
          url: `https://github.com/ggml-org/llama.cpp/releases/download/b9940/${cudartArchiveName}`,
          sha256: hashOverrides.cudart || sha256(archives.cudart),
        },
      ],
    },
  };
  const fixtureLockPath = path.join(root, 'lock.json');
  fs.writeFileSync(fixtureLockPath, JSON.stringify(lock));
  return { lock, lockPath: fixtureLockPath };
}

function createRuntimeFixture(root, overrides = {}) {
  const cacheDirectory = path.join(root, 'cache');
  const outputDirectory = path.join(root, 'output');
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const archives = {
    cpu: writeFixtureArchive(cacheDirectory, cpuArchiveName, overrides.cpuFiles || {
      'llama-server.exe': 'cpu server',
      'bin/llama.dll': 'cpu dll',
      'docs/readme.txt': 'cpu docs',
    }),
    cuda: writeFixtureArchive(cacheDirectory, cudaArchiveName, overrides.cudaFiles || {
      'llama-server.exe': 'cuda server',
      'bin/llama.dll': 'cuda dll',
    }),
    cudart: writeFixtureArchive(cacheDirectory, cudartArchiveName, overrides.cudartFiles || {
      'bin/cudart64_12.dll': 'cuda runtime dll',
    }),
  };
  const { lock, lockPath: fixtureLockPath } = writeFixtureLock(root, archives, overrides.hashOverrides);
  return { archives, cacheDirectory, lock, lockPath: fixtureLockPath, outputDirectory };
}

function stageFixture(outputDirectory, cacheDirectory, fixtureLockPath, environment = {}) {
  return childProcess.spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stagerPath,
    '-OutputDirectory', outputDirectory,
    '-CacheDirectory', cacheDirectory,
    '-LockPath', fixtureLockPath,
  ], { encoding: 'utf8', env: { ...process.env, ...environment } });
}

function assertFailure(result, message) {
  assert.notEqual(result.status, 0, `expected staging to fail; output: ${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, message);
}

function writeExistingFamilies(outputDirectory) {
  fs.mkdirSync(path.join(outputDirectory, 'cpu'), { recursive: true });
  fs.mkdirSync(path.join(outputDirectory, 'cuda'), { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, 'cpu', 'old.txt'), 'old cpu');
  fs.writeFileSync(path.join(outputDirectory, 'cuda', 'old.txt'), 'old cuda');
}

function assertExistingFamilies(outputDirectory) {
  assert.equal(fs.readFileSync(path.join(outputDirectory, 'cpu', 'old.txt'), 'utf8'), 'old cpu');
  assert.equal(fs.readFileSync(path.join(outputDirectory, 'cuda', 'old.txt'), 'utf8'), 'old cuda');
  assert.equal(fs.existsSync(path.join(outputDirectory, 'cpu', 'llama-server.exe')), false);
  assert.equal(fs.existsSync(path.join(outputDirectory, 'cuda', 'llama-server.exe')), false);
}

function expectedInventory(files) {
  return Object.entries(files)
    .map(([relativePath, contents]) => ({
      path: relativePath.replace(/\\/g, '/'),
      size: Buffer.byteLength(contents),
      sha256: sha256Contents(contents),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function readManifest(manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
}

test('pins the b9940 CPU and CUDA Windows release archives with their recorded hashes', () => {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.revision, 'b9940');
  assert.deepEqual(lock.cpu, {
    directory: 'cpu',
    archives: [{
      url: 'https://github.com/ggml-org/llama.cpp/releases/download/b9940/llama-b9940-bin-win-cpu-x64.zip',
      sha256: 'd5d7248c7aacaeb0c8f15311acb0f1081874aa7a5de55843702e9e2394a05788',
    }],
  });
  assert.deepEqual(lock.cuda, {
    directory: 'cuda',
    archives: [
      {
        url: 'https://github.com/ggml-org/llama.cpp/releases/download/b9940/llama-b9940-bin-win-cuda-12.4-x64.zip',
        sha256: '1eb3afec18662b69a8e6716978e61263c8b9f4829a6e929b8fcdcc142be51893',
      },
      {
        url: 'https://github.com/ggml-org/llama.cpp/releases/download/b9940/cudart-llama-bin-win-cuda-12.4-x64.zip',
        sha256: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
      },
    ],
  });
});

test('stages cached fixture archives into isolated CPU and CUDA folders with complete manifests', { skip: !powershellAvailable }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-runtime-stage-'));
  try {
    const cpuFiles = {
      'llama-server.exe': 'cpu server',
      'bin/llama.dll': 'cpu dll',
      'docs/readme.txt': 'cpu docs',
    };
    const cudaFiles = {
      'llama-server.exe': 'cuda server',
      'bin/llama.dll': 'cuda dll',
    };
    const cudartFiles = { 'bin/cudart64_12.dll': 'cuda runtime dll' };
    const fixture = createRuntimeFixture(root, { cpuFiles, cudaFiles, cudartFiles });

    const result = stageFixture(fixture.outputDirectory, fixture.cacheDirectory, fixture.lockPath);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(path.join(fixture.outputDirectory, 'cpu', 'llama-server.exe'), 'utf8'), 'cpu server');
    assert.equal(fs.readFileSync(path.join(fixture.outputDirectory, 'cuda', 'llama-server.exe'), 'utf8'), 'cuda server');
    assert.equal(fs.existsSync(path.join(fixture.outputDirectory, 'llama-server.exe')), false);
    assert.deepEqual(readManifest(path.join(fixture.outputDirectory, 'cpu', 'runtime-family.json')), {
      schemaVersion: 1,
      revision: 'b9940',
      family: 'cpu',
      archives: fixture.lock.cpu.archives,
      inventory: expectedInventory(cpuFiles),
    });
    assert.deepEqual(readManifest(path.join(fixture.outputDirectory, 'cuda', 'runtime-family.json')), {
      schemaVersion: 1,
      revision: 'b9940',
      family: 'cuda',
      archives: fixture.lock.cuda.archives,
      inventory: expectedInventory({ ...cudaFiles, ...cudartFiles }),
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a corrupt cached archive and preserves existing CPU and CUDA runtimes', { skip: !powershellAvailable }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-runtime-corrupt-cache-'));
  try {
    const fixture = createRuntimeFixture(root);
    writeExistingFamilies(fixture.outputDirectory);
    fs.writeFileSync(fixture.archives.cpu, 'corrupt cache data');

    const result = stageFixture(fixture.outputDirectory, fixture.cacheDirectory, fixture.lockPath);

    assertFailure(result, /SHA-256 mismatch/i);
    assertExistingFamilies(fixture.outputDirectory);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a traversal ZIP before it can create an escaped file', { skip: !powershellAvailable }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-runtime-traversal-'));
  try {
    const fixture = createRuntimeFixture(root);
    appendZipEntry(fixture.archives.cpu, '../escaped.txt', 'unsafe');
    const entries = zipEntryNames(fixture.archives.cpu);
    assert.ok(entries.includes('../escaped.txt'), entries.join(', '));
    const { lock, lockPath: updatedLockPath } = writeFixtureLock(root, fixture.archives);
    fixture.lock = lock;
    writeExistingFamilies(fixture.outputDirectory);

    const result = stageFixture(fixture.outputDirectory, fixture.cacheDirectory, updatedLockPath);

    assertFailure(result, /unsafe path/i);
    assert.equal(fs.existsSync(path.join(root, 'escaped.txt')), false);
    assertExistingFamilies(fixture.outputDirectory);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: 'rejects Python executables',
    cpuFiles: { 'llama-server.exe': 'server', 'llama.dll': 'dll', 'python.exe': 'python' },
    error: /Python executable/i,
  },
  {
    name: 'rejects nested runtime-family directories',
    cpuFiles: { 'llama-server.exe': 'server', 'llama.dll': 'dll', 'cpu/nested.dll': 'nested' },
    error: /nested runtime-family directory/i,
  },
  {
    name: 'rejects runtime layouts with no DLL files',
    cpuFiles: { 'llama-server.exe': 'server', 'readme.txt': 'no dll' },
    error: /does not contain any DLL files/i,
  },
]) {
  test(`${scenario.name} without replacing existing CPU or CUDA runtimes`, { skip: !powershellAvailable }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-runtime-layout-'));
    try {
      const fixture = createRuntimeFixture(root, { cpuFiles: scenario.cpuFiles });
      writeExistingFamilies(fixture.outputDirectory);

      const result = stageFixture(fixture.outputDirectory, fixture.cacheDirectory, fixture.lockPath);

      assertFailure(result, scenario.error);
      assertExistingFamilies(fixture.outputDirectory);
      assert.deepEqual(fs.readdirSync(fixture.outputDirectory).filter((name) => name.startsWith('.llama-')), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const overlap of [
  { name: 'equal to CPU destination', cache: (output) => path.join(output, 'cpu') },
  { name: 'inside CPU destination', cache: (output) => path.join(output, 'cpu', 'cache') },
  { name: 'containing CPU and CUDA destinations', cache: (output) => output },
  { name: 'equal to CUDA destination', cache: (output) => path.join(output, 'cuda') },
]) {
  test(`rejects a cache directory ${overlap.name} without mutation`, { skip: !powershellAvailable }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-runtime-cache-overlap-'));
    try {
      const fixture = createRuntimeFixture(root);
      writeExistingFamilies(fixture.outputDirectory);
      const cacheDirectory = overlap.cache(fixture.outputDirectory);
      fs.mkdirSync(cacheDirectory, { recursive: true });
      fs.writeFileSync(path.join(cacheDirectory, 'cache-marker.txt'), 'preserve cache');

      const result = stageFixture(fixture.outputDirectory, cacheDirectory, fixture.lockPath);

      assertFailure(result, /Cache directory overlaps managed runtime destination/i);
      assertExistingFamilies(fixture.outputDirectory);
      assert.equal(fs.readFileSync(path.join(cacheDirectory, 'cache-marker.txt'), 'utf8'), 'preserve cache');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('rejects a nonexistent cache path inside CPU without creating output or cache roots', { skip: !powershellAvailable }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-runtime-cache-overlap-new-'));
  try {
    const fixture = createRuntimeFixture(root);
    const cacheDirectory = path.join(fixture.outputDirectory, 'cpu', 'cache');

    const result = stageFixture(fixture.outputDirectory, cacheDirectory, fixture.lockPath);

    assertFailure(result, /Cache directory overlaps managed runtime destination/i);
    assert.equal(fs.existsSync(fixture.outputDirectory), false);
    assert.equal(fs.existsSync(cacheDirectory), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restores existing CPU and CUDA runtimes after CPU swaps and CUDA installation fails', { skip: !powershellAvailable }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-runtime-install-failure-'));
  try {
    const fixture = createRuntimeFixture(root);
    writeExistingFamilies(fixture.outputDirectory);

    const result = stageFixture(fixture.outputDirectory, fixture.cacheDirectory, fixture.lockPath, {
      LLAMA_RUNTIME_STAGE_TEST_MODE: 'llama-runtime-fixture-test-only',
      LLAMA_RUNTIME_STAGE_TEST_FAIL_FAMILY: 'cuda',
    });

    assertFailure(result, /simulated installation failure/i);
    assertExistingFamilies(fixture.outputDirectory);
    assert.deepEqual(fs.readdirSync(fixture.outputDirectory).filter((name) => /^\.llama-(?:cpu|cuda)-(?:stage|backup)-/i.test(name)), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not enable the installation-failure fixture seam without its explicit test token', { skip: !powershellAvailable }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-runtime-install-seam-'));
  try {
    const fixture = createRuntimeFixture(root);

    const result = stageFixture(fixture.outputDirectory, fixture.cacheDirectory, fixture.lockPath, {
      LLAMA_RUNTIME_STAGE_TEST_FAIL_FAMILY: 'cpu',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(fs.existsSync(path.join(fixture.outputDirectory, 'cpu', 'llama-server.exe')));
    assert.ok(fs.existsSync(path.join(fixture.outputDirectory, 'cuda', 'llama-server.exe')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
