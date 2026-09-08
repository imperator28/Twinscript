const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const HOST = 'twinscript-local-inference.exe';
const MAX_ARCHIVE_BYTES = 8 * 1024 ** 3;
const MAX_EXPANDED_BYTES = 24 * 1024 ** 3;
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function validateArchivePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') ||
      value.replace(/\/$/, '').split('/').some(part => !part || part === '.' || part === '..' ||
        /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw failure('runtime_unsafe_archive', 'Unsafe runtime archive path');
  }
  return value;
}
async function validateTree(root) {
  const stat = await fsp.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('runtime_unsafe_tree', 'Runtime directory must be ordinary');
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    validateArchivePath(entry.name);
    const target = path.join(root, entry.name);
    const info = await fsp.lstat(target);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw failure('runtime_unsafe_tree', 'Runtime tree contains a link or special file');
    if (info.isDirectory()) await validateTree(target);
  }
}
async function digest(file, signal) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

// PowerShell receives paths through environment variables, never interpolated commands.
async function extractRuntimeArchive(archive, destination, { signal, runtime }) {
  if (process.platform !== 'win32') throw failure('runtime_platform', 'Runtime extraction requires Windows');
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($env:TWINSCRIPT_RUNTIME_ARCHIVE)
try {
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  [long]$total = 0
  if ($zip.Entries.Count -gt 100000) { throw 'Too many archive entries' }
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName
    if (!$name -or $name.Contains('\\') -or $name.StartsWith('/')) { throw 'Unsafe archive path' }
    foreach ($part in $name.TrimEnd('/').Split('/')) {
      if (!$part -or $part -eq '.' -or $part -eq '..' -or $part -match '[<>:"|?*\\x00-\\x1f]' -or $part -match '[. ]$' -or $part -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)') { throw 'Unsafe archive path' }
    }
    if (!$seen.Add($name.TrimEnd('/'))) { throw 'Duplicate archive path' }
    $kind = ($entry.ExternalAttributes -shr 16) -band 61440
    if (($kind -ne 0 -and $kind -ne 32768 -and $kind -ne 16384) -or (($entry.ExternalAttributes -band 1024) -ne 0)) { throw 'Archive link or special file' }
    $total += $entry.Length
    if ($total -gt ${runtime?.unpackedSize || MAX_EXPANDED_BYTES}) { throw 'Archive expansion limit exceeded' }
  }
  foreach ($entry in $zip.Entries) {
    $target = [IO.Path]::Combine($env:TWINSCRIPT_RUNTIME_STAGE, $entry.FullName.Replace('/', [IO.Path]::DirectorySeparatorChar))
    if ($entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($target) | Out-Null }
    else {
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
    }
  }
} finally { $zip.Dispose() }
`;
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, signal, env: { ...process.env, TWINSCRIPT_RUNTIME_ARCHIVE: archive, TWINSCRIPT_RUNTIME_STAGE: destination }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2048); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(failure('runtime_extract_failed', `Runtime extraction failed: ${stderr}`)));
  });
}

class LocalRuntimeManager {
  constructor({ runtimes, root, sessionActive = () => false, onProgress = () => {}, fetchImpl = globalThis.fetch, verifyRuntime, extractArchive = extractRuntimeArchive, timeoutMs = 30 * 60 * 1000 }) {
    if (typeof verifyRuntime !== 'function') throw new TypeError('verifyRuntime is required');
    this.runtimes = runtimes;
    for (const runtime of runtimes) {
      if (!['openvino-cpu', 'cuda'].includes(runtime.id) || runtime.family !== (runtime.id === 'cuda' ? 'cuda' : 'cpu') ||
        !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,127}$/.test(runtime.revision) || /[.]$/.test(runtime.revision) ||
        !Number.isSafeInteger(runtime.size) || runtime.size <= 0 || runtime.size > MAX_ARCHIVE_BYTES ||
        (runtime.unpackedSize !== undefined && (!Number.isSafeInteger(runtime.unpackedSize) || runtime.unpackedSize <= 0 || runtime.unpackedSize > MAX_EXPANDED_BYTES)) ||
        !/^[a-f0-9]{64}$/i.test(runtime.sha256) || new URL(runtime.url).protocol !== 'https:') throw new TypeError('Invalid runtime catalog entry');
      validateArchivePath(runtime.revision);
    }
    if (new Set(runtimes.map(r => r.id)).size !== runtimes.length) throw new TypeError('Duplicate runtime catalog ID');
    Object.assign(this, { root: path.resolve(root), sessionActive, onProgress, fetchImpl, verifyRuntime, extractArchive, timeoutMs });
    this.states = new Map();
    this.operation = null;
  }
  runtime(id) { const runtime = this.runtimes.find(r => r.id === id); if (!runtime) throw failure('runtime_unknown', 'Unknown runtime'); return runtime; }
  directory(runtime) { return path.join(this.root, runtime.revision); }
  status() {
    return Object.fromEntries(this.runtimes.map(runtime => {
      let ready = false;
      try {
        const marker = JSON.parse(fs.readFileSync(path.join(this.directory(runtime), '.runtime-installed.json'), 'utf8'));
        ready = marker[runtime.id] === runtime.sha256 && fs.existsSync(path.join(this.directory(runtime), HOST));
      } catch { /* No verified installation marker. */ }
      const entry = { id: runtime.id, family: runtime.family, revision: runtime.revision, state: ready ? 'ready' : 'not-installed', downloadedBytes: ready ? runtime.size : 0, totalBytes: runtime.size, error: null, ...this.states.get(runtime.id) };
      return [runtime.id, { ...entry, phase: entry.state, ready: entry.state === 'ready' }];
    }));
  }
  emit(runtime, state, downloadedBytes = 0, error = null) {
    this.states.set(runtime.id, { state, downloadedBytes, error });
    try { this.onProgress({ runtimeId: runtime.id, id: runtime.id, state, phase: state, downloadedBytes, totalBytes: runtime.size, error }); } catch { /* UI listeners cannot invalidate an installation. */ }
  }
  async mutate(id, action) {
    const runtime = this.runtime(id);
    if (this.sessionActive()) throw failure('meeting_active', 'Runtime cannot change during a meeting');
    if (this.operation) throw failure('runtime_mutation_active', 'Runtime manager has an active operation');
    const controller = new AbortController();
    this.operation = { id, controller };
    const timer = setTimeout(() => controller.abort(failure('runtime_timeout', 'Runtime operation timed out')), this.timeoutMs);
    try { await action(runtime, controller.signal); this.states.delete(id); return this.status()[id]; }
    catch (error) { this.emit(runtime, 'failed', this.states.get(id)?.downloadedBytes || 0, { code: error.code || 'runtime_failed', message: error.message }); throw error; }
    finally { clearTimeout(timer); this.operation = null; }
  }
  cancel(id) { if (this.operation?.id !== id) return false; this.operation.controller.abort(failure('runtime_cancelled', 'Runtime operation cancelled')); return true; }
  async ensureRoot() {
    await fsp.mkdir(this.root, { recursive: true });
    const stat = await fsp.lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('runtime_unsafe_tree', 'Runtime root must be an ordinary directory');
  }
  async check(runtime, directory, signal) {
    signal.throwIfAborted();
    await validateTree(directory);
    if (!await this.verifyRuntime(path.join(directory, HOST))) throw failure('runtime_verification_failed', 'Runtime verification failed');
    const manifest = JSON.parse((await fsp.readFile(path.join(directory, 'runtime-manifest.json'), 'utf8')).replace(/^\uFEFF/, ''));
    if (!manifest.runtimeFamilies?.[runtime.family] || manifest.runtimeFamilies[runtime.family].revision !== runtime.revision) throw failure('runtime_verification_failed', 'Runtime family or revision verification failed');
    signal.throwIfAborted();
  }
  async download(runtime, signal) {
    const directory = path.join(this.root, '.downloads');
    await fsp.mkdir(directory, { recursive: true });
    await validateTree(directory);
    const archive = path.join(directory, `${runtime.id}-${runtime.sha256}.zip.partial`);
    let offset = 0;
    try { offset = (await fsp.stat(archive)).size; } catch { /* Fresh download. */ }
    if (offset === runtime.size && await digest(archive, signal) === runtime.sha256.toLowerCase()) return archive;
    if (offset >= runtime.size) { await fsp.rm(archive, { force: true }); offset = 0; }
    signal.throwIfAborted();
    const response = await this.fetchImpl(runtime.url, { signal, headers: offset ? { Range: `bytes=${offset}-` } : {} });
    if (!response?.ok || !response.body) throw failure('runtime_download_failed', `Runtime download failed (HTTP ${response?.status})`);
    const resumed = offset > 0 && response.status === 206;
    if (response.status === 206) {
      const range = response.headers.get('content-range');
      if (range !== `bytes ${offset}-${runtime.size - 1}/${runtime.size}`) throw failure('runtime_download_failed', 'Invalid runtime download range');
    }
    if (!resumed) offset = 0;
    let bytes = offset;
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform: (chunk, _encoding, callback) => {
      bytes += chunk.length;
      if (bytes > runtime.size) return callback(failure('runtime_size_mismatch', 'Runtime archive exceeds expected size'));
      this.emit(runtime, 'downloading', bytes); callback(null, chunk);
    } }), fs.createWriteStream(archive, { flags: resumed ? 'a' : 'w' }), { signal });
    this.emit(runtime, 'verifying', bytes);
    if (bytes !== runtime.size || await digest(archive, signal) !== runtime.sha256.toLowerCase()) {
      await fsp.rm(archive, { force: true });
      throw failure('runtime_hash_mismatch', 'Runtime archive size or hash mismatch');
    }
    return archive;
  }
  async switchDirectory(runtime, stage, signal) {
    signal.throwIfAborted();
    if (this.sessionActive()) throw failure('meeting_active', 'Runtime cannot change during a meeting');
    const destination = this.directory(runtime);
    const backup = path.join(this.root, '.staging', crypto.randomUUID());
    let moved = false;
    try { await fsp.rename(destination, backup); moved = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await fsp.rename(stage, destination); }
    catch (error) { if (moved) await fsp.rename(backup, destination); throw error; }
    if (moved) await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
  }
  async installInto(runtime, signal) {
    await this.ensureRoot();
    const staging = path.join(this.root, '.staging');
    await fsp.mkdir(staging, { recursive: true });
    await validateTree(staging);
    const stats = await fsp.statfs(this.root);
    const base = this.runtimes.find(r => r.family === 'cpu' && r.revision === runtime.revision);
    const expanded = runtime.unpackedSize || MAX_EXPANDED_BYTES;
    const copiedBase = runtime.family === 'cuda' ? (base?.unpackedSize || MAX_EXPANDED_BYTES) : 0;
    if (stats.bavail * stats.bsize < runtime.size + expanded + copiedBase + 64 * 1024 ** 2) throw failure('runtime_disk_space', 'Insufficient free disk space for runtime staging');
    if (runtime.family === 'cuda') {
      if (!base || this.status()[base.id].state !== 'ready') throw failure('runtime_cpu_required', 'Install and verify the CPU runtime first');
      await this.check(base, this.directory(base), signal);
    }
    this.emit(runtime, 'downloading');
    const archive = await this.download(runtime, signal);
    const stage = await fsp.mkdtemp(path.join(staging, 'install-'));
    try {
      if (runtime.family === 'cuda') await fsp.cp(this.directory(base), stage, { recursive: true });
      await this.extractArchive(archive, stage, { signal, runtime });
      this.emit(runtime, 'verifying', runtime.size);
      await this.check(runtime, stage, signal);
      const marker = { [runtime.id]: runtime.sha256 };
      if (runtime.family === 'cuda') marker[base.id] = base.sha256;
      await fsp.writeFile(path.join(stage, '.runtime-installed.json'), JSON.stringify(marker));
      await this.switchDirectory(runtime, stage, signal);
      for (const entry of this.runtimes.filter(r => r.revision === runtime.revision)) this.states.delete(entry.id);
    } finally { await fsp.rm(stage, { recursive: true, force: true }); }
  }
  install(id) { return this.mutate(id, (runtime, signal) => this.installInto(runtime, signal)); }
  verify(id) { return this.mutate(id, async (runtime, signal) => { this.emit(runtime, 'verifying'); await this.check(runtime, this.directory(runtime), signal); }); }
  remove(id) {
    return this.mutate(id, async (runtime, signal) => {
      await this.ensureRoot();
      if (runtime.family === 'cuda') {
        // Rebuild from the authenticated base archive rather than editing a signed inventory.
        const base = this.runtimes.find(r => r.family === 'cpu' && r.revision === runtime.revision);
        if (!base) throw failure('runtime_cpu_required', 'CPU runtime catalog entry is required');
        await this.installInto(base, signal);
      } else {
        const directory = this.directory(runtime);
        try { await validateTree(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        signal.throwIfAborted();
        await fsp.rm(directory, { recursive: true, force: true });
        for (const entry of this.runtimes.filter(r => r.revision === runtime.revision)) this.states.delete(entry.id);
      }
    });
  }
}

module.exports = { LocalRuntimeManager, validateArchivePath, extractRuntimeArchive };
