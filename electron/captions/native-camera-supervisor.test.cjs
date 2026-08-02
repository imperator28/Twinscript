const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  NativeCameraSupervisor,
  nativeCameraSupport,
  registeredMachineCamera,
} = require('./native-camera-supervisor');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.killed = false;
  }

  kill() {
    this.killed = true;
    return true;
  }
}

class FakeSocket extends EventEmitter {
  write(value) {
    this.writes ||= [];
    this.writes.push(value);
  }

  end() {
    this.ended = true;
  }
}

function harness({ installed = true } = {}) {
  const spawns = [];
  const servers = [];
  const health = [];
  const supervisor = new NativeCameraSupervisor({
    platform: 'win32',
    release: '10.0.26200',
    arch: 'x64',
    hostPath: 'C:\\ProgramData\\Bilingual Meeting Captions\\bin\\vcam-host.exe',
    sourcePath: 'C:\\ProgramData\\Bilingual Meeting Captions\\bin\\bilingual-vcam-source.dll',
    regionPath: 'C:\\ProgramData\\Bilingual Meeting Captions\\runtime\\camera-frame-v1.bin',
    isInstalled: () => installed,
    randomId: () => 'fixed-test',
    restartDelayMs: 0,
    stopTimeoutMs: 20,
    spawn: (command, args, options) => {
      const child = new FakeChild();
      spawns.push({ command, args, options, child });
      return child;
    },
    createPipeServer: (onConnection) => {
      const server = new EventEmitter();
      server.listen = (pipeName) => {
        server.pipeName = pipeName;
        server.listening = true;
      };
      server.close = () => { server.closed = true; };
      server.connect = () => {
        const socket = new FakeSocket();
        onConnection(socket);
        server.socket = socket;
        return socket;
      };
      servers.push(server);
      return server;
    },
    onHealth: (snapshot) => health.push(snapshot),
  });
  return { supervisor, spawns, servers, health };
}

test('native camera support is limited to Windows 11 x64', () => {
  assert.deepEqual(nativeCameraSupport('win32', '10.0.22000', 'x64'), {
    supported: true,
    reason: null,
    windowsBuild: 22000,
  });
  assert.equal(nativeCameraSupport('win32', '10.0.19045', 'x64').reason, 'windows-11-required');
  assert.equal(nativeCameraSupport('darwin', '23.0.0', 'x64').reason, 'windows-only');
  assert.equal(nativeCameraSupport('win32', '10.0.26200', 'arm64').reason, 'x64-required');
});

test('starts the installed companion with a health-only named pipe and region path', async () => {
  const { supervisor, spawns, servers } = harness();
  const starting = await supervisor.start();

  assert.equal(starting.state, 'starting');
  assert.equal(servers.length, 1);
  assert.equal(servers[0].pipeName, '\\\\.\\pipe\\bilingual-meeting-camera-fixed-test');
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, [
    'serve',
    '--region',
    'C:\\ProgramData\\Bilingual Meeting Captions\\runtime\\camera-frame-v1.bin',
    '--pipe',
    '\\\\.\\pipe\\bilingual-meeting-camera-fixed-test',
  ]);
  assert.equal(spawns[0].options.windowsHide, true);
  assert.equal(spawns[0].options.stdio, 'ignore');

  const socket = servers[0].connect();
  socket.emit('data', Buffer.from('{"state":"ready","code":0}\n{"state":"streaming","code":0}\n'));
  assert.equal(supervisor.snapshot().state, 'streaming');
});

test('reports unsupported and not-installed states without spawning', async () => {
  const unsupported = new NativeCameraSupervisor({
    platform: 'win32', release: '10.0.19045', arch: 'x64',
    isInstalled: () => true,
  });
  assert.equal((await unsupported.start()).state, 'unsupported');

  const { supervisor, spawns } = harness({ installed: false });
  assert.equal((await supervisor.start()).state, 'not-installed');
  assert.equal(spawns.length, 0);
});

test('a graceful stop uses the control pipe and does not count as a crash', async () => {
  const { supervisor, spawns, servers } = harness();
  await supervisor.start();
  const socket = servers[0].connect();
  socket.emit('data', Buffer.from('{"state":"ready"}\n'));

  const stopping = supervisor.stop();
  assert.deepEqual(socket.writes, ['{"command":"stop"}\n']);
  spawns[0].child.emit('exit', 0, null);
  await stopping;
  assert.equal(supervisor.snapshot().state, 'stopped');
  assert.equal(spawns.length, 1);
});

test('restarts once after an unexpected exit and then requires manual recovery', async () => {
  const { supervisor, spawns } = harness();
  await supervisor.start();
  spawns[0].child.emit('exit', 21, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(spawns.length, 2);
  assert.equal(supervisor.snapshot().restartCount, 1);
  assert.equal(supervisor.snapshot().state, 'starting');

  spawns[1].child.emit('exit', 22, null);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(spawns.length, 2);
  assert.equal(supervisor.snapshot().state, 'failed');
  assert.match(supervisor.snapshot().message, /manual/i);
});

test('camera failure is isolated and never invokes a transcription stop callback', async () => {
  let transcriptionStops = 0;
  const { supervisor, spawns } = harness();
  supervisor.stopTranscription = () => { transcriptionStops += 1; };
  await supervisor.start();
  spawns[0].child.emit('error', new Error('camera crashed'));
  spawns[0].child.emit('exit', 1, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transcriptionStops, 0);
});

test('a spawn error clears the poisoned child and allows manual retry', async () => {
  const { supervisor, spawns } = harness();
  await supervisor.start();
  spawns[0].child.emit('error', Object.assign(new Error('missing host'), { code: 'ENOENT' }));
  assert.equal(supervisor.child, null);
  assert.equal(supervisor.snapshot().state, 'restarting');

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(spawns.length, 2);
  spawns[1].child.emit('error', Object.assign(new Error('still missing'), { code: 'ENOENT' }));
  assert.equal(supervisor.child, null);
  assert.equal(supervisor.snapshot().state, 'failed');

  await supervisor.start({ manual: true });
  assert.equal(spawns.length, 3);
});

test('an installed binary mismatch requires repair before launch', async () => {
  const { supervisor, spawns } = harness({ installed: 'repair-required' });
  const status = await supervisor.start();
  assert.equal(status.state, 'repair-required');
  assert.equal(status.installed, true);
  assert.equal(spawns.length, 0);
});

test('installed status compares packaged and ProgramData binaries byte-for-byte', () => {
  const files = new Map([
    ['installed-host', Buffer.from('host-v1')],
    ['installed-source', Buffer.from('source-v1')],
    ['packaged-host', Buffer.from('host-v2')],
    ['packaged-source', Buffer.from('source-v1')],
  ]);
  const status = registeredMachineCamera({
    hostPath: 'installed-host',
    sourcePath: 'installed-source',
    expectedHostPath: 'packaged-host',
    expectedSourcePath: 'packaged-source',
    existsSync: (file) => files.has(file),
    readFileSync: (file) => files.get(file),
    run: () => ({ status: 0 }),
  });
  assert.equal(status, 'repair-required');
  files.set('packaged-host', Buffer.from('host-v1'));
  assert.equal(
    registeredMachineCamera({
      hostPath: 'installed-host',
      sourcePath: 'installed-source',
      expectedHostPath: 'packaged-host',
      expectedSourcePath: 'packaged-source',
      existsSync: (file) => files.has(file),
      readFileSync: (file) => files.get(file),
      run: () => ({ status: 0 }),
    }),
    true,
  );
});
