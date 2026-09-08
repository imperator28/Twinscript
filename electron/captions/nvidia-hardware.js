const childProcess = require('node:child_process');

// This only offers the optional download. The installed llama CUDA probe must
// still verify driver/runtime compatibility and actual GPU offload before use.
function detectNvidiaHardware({ platform = process.platform, execFile = childProcess.execFile } = {}) {
  if (platform !== 'win32') return Promise.resolve(false);
  return new Promise(resolve => {
    execFile('nvidia-smi.exe', ['--query-gpu=name', '--format=csv,noheader'],
      { windowsHide: true, timeout: 5000, maxBuffer: 16384 },
      (error, stdout) => resolve(!error && /\bNVIDIA\b/i.test(String(stdout))));
  });
}
module.exports = { detectNvidiaHardware };
