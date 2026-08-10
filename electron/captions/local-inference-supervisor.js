const { EventEmitter } = require('events');
const path = require('path');
const childProcess = require('child_process');
const { LocalInferenceClient } = require('./local-inference-client');

function supervisorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolveLocalInferenceExecutable({ isPackaged, resourcesPath, appPath }) {
  const root = isPackaged
    ? path.win32.join(resourcesPath, 'local-inference-host')
    : path.win32.join(appPath, 'artifacts', 'local-inference-host');
  return path.win32.join(root, 'twinscript-local-inference.exe');
}

class LocalInferenceSupervisor extends EventEmitter {
  constructor({
    spawn = childProcess.spawn,
    isPackaged = false,
    resourcesPath = process.resourcesPath || '',
    appPath = process.cwd(),
    executablePath,
  } = {}) {
    super();
    this.spawnImpl = spawn;
    this.executablePath = executablePath || resolveLocalInferenceExecutable({
      isPackaged,
      resourcesPath,
      appPath,
    });
    this.generation = 0;
    this.restartCount = 0;
    this.child = null;
    this.activeClient = null;
    this.transport = null;
  }

  accept(message) {
    if (message?.generation !== this.generation) return false;
    this.emit('message', message);
    return true;
  }

  createTransport(child) {
    const transport = new EventEmitter();
    transport.write = (line) => child.stdin.write(line);
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const message = { ...JSON.parse(line), generation: this.generation };
          if (this.accept(message)) transport.emit('message', message);
        } catch (error) {
          this.emit('diagnostic', { code: 'local_host_invalid_json', message: error.message });
        }
      }
    });
    child.once('close', () => transport.emit('close'));
    child.stderr.on('data', (chunk) => this.emit('diagnostic', {
      code: 'local_host_stderr',
      message: chunk.toString('utf8').slice(-2000),
    }));
    return transport;
  }

  async start() {
    if (this.activeClient) return this.activeClient;
    this.generation += 1;
    const child = this.spawnImpl(this.executablePath, [], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.transport = this.createTransport(child);
    const client = new LocalInferenceClient({
      transport: this.transport,
      generation: this.generation,
      timeoutMs: 30_000,
    });
    this.activeClient = client;
    try {
      await client.request('hello', { sessionId: 'local-host' }, { timeoutMs: 30_000 });
      return client;
    } catch (error) {
      await this.disposeProcess();
      throw error;
    }
  }

  async probe() {
    const client = await this.start();
    return client.request('health', { sessionId: 'local-host' });
  }

  async prepare(models, sessionId = 'local-host') {
    const client = await this.start();
    return client.request('model.prepare', { sessionId, models }, { timeoutMs: 120_000 });
  }

  client() {
    if (!this.activeClient) {
      throw supervisorError('local_host_not_ready', 'Local inference host is not ready');
    }
    return this.activeClient;
  }

  async restart() {
    if (this.restartCount >= 1) {
      throw supervisorError(
        'local_host_restart_exhausted',
        'Local inference host already restarted once in this session',
      );
    }
    this.restartCount += 1;
    await this.disposeProcess();
    return this.start();
  }

  async disposeProcess() {
    const client = this.activeClient;
    const child = this.child;
    this.activeClient = null;
    this.transport = null;
    this.child = null;
    if (!child) return;
    try {
      if (client && child.exitCode == null) {
        await client.request('shutdown', { sessionId: 'local-host' }, { timeoutMs: 2_000 });
      }
    } catch {
      // The bounded kill below is the fail-safe for an unresponsive host.
    } finally {
      client?.dispose();
    }
    if (child.exitCode == null) child.kill();
  }

  async dispose() {
    await this.disposeProcess();
    this.removeAllListeners();
  }
}

module.exports = {
  LocalInferenceSupervisor,
  resolveLocalInferenceExecutable,
};
