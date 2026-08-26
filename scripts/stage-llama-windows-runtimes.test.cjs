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

const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const psLiteral = (value) => `'${value.replace(/'/g, "''")}'`;

function createZip(sourceDirectory, zipPath) {
  const command = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `[System.IO.Compression.ZipFile]::CreateFromDirectory(${psLiteral(sourceDirectory)}, ${psLiteral(zipPath)})`,
  ].join('; ');
  const result = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
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

function writeFixtureLock(root, cpuArchive, cudaArchive, cudartArchive) {
  const lock = {
    schemaVersion: 1,
    revision: 'b9940',
    cpu: {
      directory: 'cpu',
      archives: [{
        url: 'https://github.com/ggml-org/llama.cpp/releases/download/b9940/llama-b9940-bin-win-cpu-x64.zip',
        sha256: sha256(cpuArchive),
      }],
    },
    cuda: {
      directory: 'cuda',
      archives: [
        {
          url: 'https://github.com/ggml-org/llama.cpp/releases/download/b9940/llama-b9940-bin-win-cuda-12.4-x64.zip',
          sha256: sha256(cudaArchive),
        },
        {
          url: 'https://github.com/ggml-org/llama.cpp/releases/download/b9940/cudart-llama-bin-win-cuda-12.4-x64.zip',
          sha256: sha256(cudartArchive),
        },
      ],
    },
  };
  const lockPath = path.join(root, 'lock.json');
  fs.writeFileSync(lockPath, JSON.stringify(lock));
  return lockPath;
}

function stageFixture(outputDirectory, cacheDirectory, lockPath) {
  return childProcess.spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stagerPath,
    '-OutputDirectory', outputDirectory,
    '-CacheDirectory', cacheDirectory,
    '-LockPath', lockPath,
  ], { encoding: 'utf8' });
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

test('stager keeps CPU and CUDA archives in explicitly isolated destinations', () => {
  const source = fs.readFileSync(stagerPath, 'utf8');

  assert.match(source, /\$cpuDestination\s*=\s*Join-Path\s+\$outputRoot\s+\$lock\.cpu\.directory/);
  assert.match(source, /\$cudaDestination\s*=\s*Join-Path\s+\$outputRoot\s+\$lock\.cuda\.directory/);
  assert.doesNotMatch(source, /Expand-Archive[^\r\n]*-DestinationPath\s+\$outputRoot\b/);
  assert.match(source, /llama-server\.exe/);
  assert.match(source, /runtime-family\.json/);
});

test('stages cached fixture archives into isolated CPU and CUDA runtime folders', { skip: !powershellAvailable }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-runtime-stage-'));
  try {
    const cacheDirectory = path.join(root, 'cache');
    const outputDirectory = path.join(root, 'output');
    fs.mkdirSync(cacheDirectory);
    const cpuArchive = writeFixtureArchive(cacheDirectory, 'llama-b9940-bin-win-cpu-x64.zip', {
      'llama-server.exe': 'cpu server',
      'llama.dll': 'cpu dll',
    });
    const cudaArchive = writeFixtureArchive(cacheDirectory, 'llama-b9940-bin-win-cuda-12.4-x64.zip', {
      'llama-server.exe': 'cuda server',
      'llama.dll': 'cuda dll',
    });
    const cudartArchive = writeFixtureArchive(cacheDirectory, 'cudart-llama-bin-win-cuda-12.4-x64.zip', {
      'cudart64_12.dll': 'cuda runtime dll',
    });
    const lockPath = writeFixtureLock(root, cpuArchive, cudaArchive, cudartArchive);

    const result = stageFixture(outputDirectory, cacheDirectory, lockPath);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(path.join(outputDirectory, 'cpu', 'llama-server.exe'), 'utf8'), 'cpu server');
    assert.equal(fs.readFileSync(path.join(outputDirectory, 'cuda', 'llama-server.exe'), 'utf8'), 'cuda server');
    assert.ok(fs.existsSync(path.join(outputDirectory, 'cpu', 'runtime-family.json')));
    assert.ok(fs.existsSync(path.join(outputDirectory, 'cuda', 'runtime-family.json')));
    assert.equal(fs.existsSync(path.join(outputDirectory, 'llama-server.exe')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('leaves no staged family behind when fixture layout validation fails', { skip: !powershellAvailable }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-runtime-stage-failure-'));
  try {
    const cacheDirectory = path.join(root, 'cache');
    const outputDirectory = path.join(root, 'output');
    fs.mkdirSync(cacheDirectory);
    const cpuArchive = writeFixtureArchive(cacheDirectory, 'llama-b9940-bin-win-cpu-x64.zip', {
      'llama.dll': 'cpu dll without server',
    });
    const cudaArchive = writeFixtureArchive(cacheDirectory, 'llama-b9940-bin-win-cuda-12.4-x64.zip', {
      'llama-server.exe': 'cuda server',
      'llama.dll': 'cuda dll',
    });
    const cudartArchive = writeFixtureArchive(cacheDirectory, 'cudart-llama-bin-win-cuda-12.4-x64.zip', {
      'cudart64_12.dll': 'cuda runtime dll',
    });
    const lockPath = writeFixtureLock(root, cpuArchive, cudaArchive, cudartArchive);

    const result = stageFixture(outputDirectory, cacheDirectory, lockPath);

    assert.notEqual(result.status, 0, 'invalid fixture layout should fail staging');
    assert.equal(fs.existsSync(path.join(outputDirectory, 'cpu')), false);
    assert.equal(fs.existsSync(path.join(outputDirectory, 'cuda')), false);
    assert.deepEqual(fs.readdirSync(outputDirectory).filter((name) => name.startsWith('.llama-')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
