// Copy ONNX Runtime WASM files from node_modules into public/wasm/ort/
// so that workers load them locally instead of from cdn.jsdelivr.net.
//
// Called automatically via npm postinstall. Plain Node so `npm ci` works in
// PowerShell, cmd.exe, and POSIX shells without depending on Git Bash.

const fs = require('fs');
const path = require('path');

const SRC = path.join('node_modules', 'onnxruntime-web', 'dist');
const DEST = path.join('public', 'wasm', 'ort');

// Needed WASM variants:
//   asyncify  — default (non-Safari browsers)
//   plain     — Safari fallback (no asyncify support)
//   jsep      — WebGPU/WebNN backend (used by Whisper-WebGPU, Qwen workers)
// JS entry point:
//   ort.wasm.min.js — UMD, for classic workers using importScripts() (piper-plus-tts)
// Note: TS workers (Whisper, Voxtral, Cohere, Granite, Supertonic) import
// `onnxruntime-web` directly and let Vite bundle the ESM API surface into
// each worker chunk — so no standalone ESM entry needs to live here.
const FILES = [
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort.wasm.min.js',
];

/**
 * Copy the ORT runtime files into the public asset directory.
 *
 * Returns `{ skipped: true }` when onnxruntime-web is not installed yet, so a
 * partial install cannot fail the whole postinstall step. Missing individual
 * files are warnings, matching the previous shell script: the tracked copies in
 * `public/wasm/ort/` stay in place and the build still has its assets.
 */
function copyOrtWasm({
  cwd = process.cwd(),
  files = FILES,
  logger = console,
} = {}) {
  const srcDir = path.resolve(cwd, SRC);
  const destDir = path.resolve(cwd, DEST);

  if (!fs.existsSync(srcDir)) {
    logger.info('[copy-ort-wasm] onnxruntime-web not installed yet — skipping.');
    return { skipped: true, copied: [], missing: [] };
  }

  fs.mkdirSync(destDir, { recursive: true });

  const copied = [];
  const missing = [];
  for (const file of files) {
    const from = path.join(srcDir, file);
    if (fs.existsSync(from) && fs.statSync(from).isFile()) {
      fs.copyFileSync(from, path.join(destDir, file));
      copied.push(file);
    } else {
      missing.push(file);
      logger.warn(`[copy-ort-wasm] WARNING: ${path.join(SRC, file)} not found`);
    }
  }

  logger.info(
    `[copy-ort-wasm] Copied ${copied.length} ORT WASM files → ${DEST}${path.sep}`,
  );
  return { skipped: false, copied, missing };
}

if (require.main === module) {
  try {
    copyOrtWasm();
  } catch (error) {
    console.error('[copy-ort-wasm] Failed:', error);
    process.exitCode = 1;
  }
}

module.exports = { copyOrtWasm, FILES, SRC, DEST };
