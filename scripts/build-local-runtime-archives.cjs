const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { validateRuntimeLayoutManifest } = require('./local-inference-runtime-layout.cjs');
const { validateArchivePath } = require('../electron/captions/local-runtime-manager');

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const data of fs.createReadStream(file)) hash.update(data);
  return hash.digest('hex');
}

async function ordinaryFile(root, relative) {
  validateArchivePath(relative);
  let current = root;
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    if ((await fsp.lstat(current)).isSymbolicLink()) throw new Error(`Runtime inventory contains a symbolic link: ${relative}`);
  }
  const stat = await fsp.stat(current);
  if (!stat.isFile()) throw new Error(`Runtime inventory entry is not a file: ${relative}`);
  return stat;
}

async function createZip(inventoryPath, outputPath) {
  if (process.platform !== 'win32') throw new Error('Runtime archive production requires Windows PowerShell');
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$items = Get-Content -LiteralPath $env:TWINSCRIPT_ZIP_INVENTORY -Raw | ConvertFrom-Json
$zip = [IO.Compression.ZipFile]::Open($env:TWINSCRIPT_ZIP_OUTPUT, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($item in $items) {
    $entry = $zip.CreateEntry($item.path, [IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
    $inputStream = [IO.File]::OpenRead($item.source)
    try {
      $outputStream = $entry.Open()
      try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
    } finally { $inputStream.Dispose() }
  }
} finally { $zip.Dispose() }
`;
  await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 30 * 60 * 1000, maxBuffer: 1024 * 1024,
    env: { ...process.env, TWINSCRIPT_ZIP_INVENTORY: inventoryPath, TWINSCRIPT_ZIP_OUTPUT: outputPath },
  });
}

async function buildRuntimeArchives({ sourceDirectory, outputDirectory }) {
  const source = path.resolve(sourceDirectory);
  const output = path.resolve(outputDirectory);
  const relativeOutput = path.relative(source, output);
  if (!relativeOutput || (relativeOutput !== '..' && !relativeOutput.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeOutput))) throw new Error('Archive output must be outside the staged source');
  if (!(await fsp.lstat(source)).isDirectory() || (await fsp.lstat(source)).isSymbolicLink()) throw new Error('Staged source must be an ordinary directory');
  await ordinaryFile(source, 'runtime-manifest.json');
  const manifest = JSON.parse((await fsp.readFile(path.join(source, 'runtime-manifest.json'), 'utf8')).replace(/^\uFEFF/, ''));
  const { revision } = validateRuntimeLayoutManifest(manifest);
  validateArchivePath(revision);
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,127}$/.test(revision)) throw new Error('Unsafe runtime revision');
  const seen = new Set();
  for (const entry of manifest.files) {
    if (entry.path === 'runtime-manifest.json' || seen.has(entry.path.toLowerCase())) throw new Error('Runtime inventory contains a duplicate path');
    seen.add(entry.path.toLowerCase());
    const stat = await ordinaryFile(source, entry.path);
    if (stat.size !== entry.size || await sha256(path.join(source, entry.path)) !== entry.sha256.toLowerCase()) throw new Error(`Runtime inventory size or hash mismatch: ${entry.path}`);
  }
  if (!seen.has('twinscript-local-inference.exe')) throw new Error('Runtime inventory is missing the native host');
  await fsp.mkdir(output, { recursive: true });
  if ((await fsp.lstat(output)).isSymbolicLink()) throw new Error('Archive output must be an ordinary directory');
  const specifications = [{ id: 'openvino-cpu', family: 'cpu' }, { id: 'cuda', family: 'cuda' }].map(runtime => ({ ...runtime, revision, fileName: `twinscript-runtime-${runtime.id}-${revision}.zip` }));
  for (const name of [...specifications.map(r => r.fileName), 'runtime-archives.json']) {
    try { await fsp.lstat(path.join(output, name)); throw new Error(`Archive output already exists: ${name}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const temporary = await fsp.mkdtemp(path.join(output, '.runtime-archives-'));
  const published = [];
  try {
    const runtimes = [];
    for (const runtime of specifications) {
      const isCuda = entry => entry.path.startsWith('llama/cuda/');
      const files = manifest.files.filter(entry => runtime.family === 'cuda' ? isCuda(entry) : !isCuda(entry));
      const inventoryManifest = runtime.family === 'cuda' ? manifest : { ...manifest, artifactKind: 'cpu-runtime', runtimeFamilies: { cpu: manifest.runtimeFamilies.cpu }, files };
      const manifestBytes = Buffer.from(`${JSON.stringify(inventoryManifest, null, 2)}\n`);
      const customManifest = path.join(temporary, `${runtime.id}-manifest.json`);
      await fsp.writeFile(customManifest, manifestBytes);
      const entries = files.map(entry => ({ path: entry.path, source: path.join(source, ...entry.path.split('/')) }));
      entries.push({ path: 'runtime-manifest.json', source: customManifest });
      entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
      const inventoryPath = path.join(temporary, `${runtime.id}-inventory.json`);
      await fsp.writeFile(inventoryPath, JSON.stringify(entries));
      const archive = path.join(temporary, runtime.fileName);
      await createZip(inventoryPath, archive);
      runtimes.push({ ...runtime, size: (await fsp.stat(archive)).size, sha256: await sha256(archive), unpackedSize: files.reduce((sum, entry) => sum + entry.size, manifestBytes.length) });
    }
    // Recheck after compression to refuse a source changed during the archive build.
    for (const entry of manifest.files) {
      if (await sha256(path.join(source, entry.path)) !== entry.sha256.toLowerCase()) throw new Error(`Runtime source changed during archive build: ${entry.path}`);
    }
    const result = { runtimes };
    await fsp.writeFile(path.join(temporary, 'runtime-archives.json'), `${JSON.stringify(result, null, 2)}\n`);
    for (const name of [...runtimes.map(r => r.fileName), 'runtime-archives.json']) {
      const destination = path.join(output, name);
      await fsp.copyFile(path.join(temporary, name), destination, fs.constants.COPYFILE_EXCL);
      published.push(destination);
    }
    return result;
  } catch (error) {
    for (const file of published) await fsp.rm(file, { force: true });
    throw error;
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const sourceDirectory = args[args.indexOf('--source') + 1];
  const outputDirectory = args[args.indexOf('--output') + 1];
  if (!args.includes('--source') || !args.includes('--output') || !sourceDirectory || !outputDirectory) {
    console.error('Usage: node scripts/build-local-runtime-archives.cjs --source <staged-runtime> --output <release-directory>');
    process.exitCode = 1;
  } else buildRuntimeArchives({ sourceDirectory, outputDirectory }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { buildRuntimeArchives };
