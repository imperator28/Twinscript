// CI-only packaged launch/control-window-close check. No API key or capture.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const executable = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(executable)) throw new Error('Pass the packaged app executable');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'twinscript-smoke-'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, socket, exited = false, exitCode;
try {
  child = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
    { stdio: 'ignore', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
  child.once('error', () => { exited = true; exitCode = -1; });
  child.once('exit', code => { exited = true; exitCode = code; });
  let target;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (exited) throw new Error('Packaged app exited before the control window appeared');
    try {
      const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
      const pages = await (await fetch(`http://127.0.0.1:${Number(port)}/json/list`)).json();
      target = pages.find(p => p.type === 'page' && p.url.startsWith('file:') && p.url.includes('surface=control'));
      if (target) break;
    } catch {}
    await wait(250);
  }
  if (!target) throw new Error('No packaged control window within 45 seconds');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let nextId = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { socket.off('message', onMessage); reject(new Error(`CDP ${method} timed out`)); }, 5000);
    function onMessage(data) {
      const reply = JSON.parse(data);
      if (reply.id !== id) return;
      clearTimeout(timer); socket.off('message', onMessage);
      if (reply.error) reject(new Error(`CDP ${method} failed`)); else resolve(reply.result);
    }
    socket.on('message', onMessage); socket.send(JSON.stringify({ id, method, params }));
  });
  await wait(3000);
  if (exited) throw new Error('Packaged app crashed after startup');
  const state = await request('Runtime.evaluate', { expression: 'Boolean(window.captions && document.querySelector("#root")?.textContent?.trim())', returnByValue: true });
  if (state.result?.value !== true) throw new Error('Packaged renderer or preload failed to initialize');
  // Page.close runs the actual BrowserWindow close lifecycle, not app.quit or kill.
  await request('Page.close');
  const shutdown = Date.now() + 40000;
  while (!exited && Date.now() < shutdown) await wait(250);
  if (!exited || exitCode !== 0) throw new Error('Closing control window did not exit cleanly');
  const processes = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).split('\n');
  if (processes.some(command => command.startsWith(executable + ' ') || command.startsWith(path.dirname(path.dirname(executable)) + '/Frameworks/'))) {
    throw new Error('Packaged helper processes survived control-window close');
  }
  console.log('PASS: packaged control rendered, survived startup, closed, and exited with helpers. Capture and camera untested.');
} finally {
  socket?.close();
  if (child && !exited) child.kill('SIGKILL');
  fs.rmSync(profile, { recursive: true, force: true });
}
