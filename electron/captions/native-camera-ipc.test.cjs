const assert = require('node:assert/strict');
const test = require('node:test');

const { registerCaptionIpc } = require('./register-caption-ipc');

function windowWithId(id) {
  return {
    isDestroyed: () => false,
    webContents: { id, send() {} },
  };
}

function harness() {
  const handlers = new Map();
  const calls = [];
  const health = {
    state: 'stopped',
    supported: true,
    installed: true,
    restartCount: 0,
  };
  const windows = {
    controlWindow: windowWithId(1),
    captionWindows: new Map(),
    cameraStageWindow: null,
    cameraOutputWindow: windowWithId(4),
    outputMode: 'virtual-camera',
    stopCameraOutput: async () => calls.push('windows:stop'),
    startCameraOutput: () => calls.push('windows:start'),
    settingsPayload: (value) => value,
    broadcast() {},
    broadcastControl() {},
    resetAutoSize() {},
    applySettings() {},
    previewVisibility: () => ({}),
    cameraStageSnapshot: () => ({ status: {}, captions: [] }),
  };
  const supervisor = {
    snapshot: () => ({ ...health }),
    refresh: async () => ({ ...health }),
    start: async (options) => {
      calls.push(`supervisor:start:${Boolean(options?.manual)}`);
      return { ...health, state: 'starting' };
    },
  };
  const installer = {
    install: async () => calls.push('installer:install'),
    repair: async () => calls.push('installer:repair'),
    remove: async () => {
      calls.push('installer:remove');
      health.installed = false;
      health.state = 'not-installed';
    },
  };
  registerCaptionIpc({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      on() {},
    },
    app: { getPath: () => 'C:\\Documents', getVersion: () => 'test' },
    dialog: {},
    shell: {},
    windows,
    sessionManager: {
      snapshot: () => ({}), export: () => '', rateEvaluation() {},
      setScreeningPrompt() {}, abortShadow() {}, start() {}, stop() {},
    },
    settingsStore: { get: () => ({}), set: () => ({}) },
    credentialStore: { status() {}, set() {}, delete() {}, validate() {} },
    evaluationRecorder: { list: () => [] },
    meetingRecordController: null,
    requestMicrophoneAccess: () => ({}),
    nativeCameraSupervisor: supervisor,
    nativeCameraInstaller: installer,
    localInferenceSupervisor: {
      readiness: () => ({
        runtimeReady: true,
        requestedDevice: 'NPU',
        models: {
          'whisper-small': { ready: true, actualDevice: null },
          'hy-mt2-1.8b': { ready: false, actualDevice: null },
        },
      }),
    },
  });
  const invoke = async (channel, senderId = 1) =>
    handlers.get(channel)({ sender: { id: senderId } });
  return { invoke, calls };
}

test('native camera IPC exposes health and serializes lifecycle actions', async () => {
  const { invoke, calls } = harness();
  assert.deepEqual((await invoke('captions:native-camera-health-get')).data, {
    state: 'stopped', supported: true, installed: true, restartCount: 0,
  });

  await invoke('captions:native-camera-install');
  assert.deepEqual(calls, ['installer:install', 'windows:start']);
  calls.length = 0;

  await invoke('captions:native-camera-repair');
  assert.deepEqual(calls, ['windows:stop', 'installer:repair', 'windows:start']);
  calls.length = 0;

  await invoke('captions:native-camera-retry');
  assert.deepEqual(calls, ['supervisor:start:true', 'windows:start']);
  calls.length = 0;

  await invoke('captions:native-camera-remove');
  assert.deepEqual(calls, ['windows:stop', 'installer:remove']);
});

test('the offscreen stage is a trusted narrow IPC sender', async () => {
  const { invoke } = harness();
  const result = await invoke('captions:native-camera-health-get', 4);
  assert.equal(result.ok, true);
});

test('local inference readiness is exposed through narrow IPC', async () => {
  const { invoke } = harness();
  const result = await invoke('captions:local-inference-status');
  assert.equal(result.ok, true);
  assert.equal(result.data.runtimeReady, true);
  assert.equal(result.data.models['whisper-small'].ready, true);
  assert.equal(result.data.models['hy-mt2-1.8b'].ready, false);
});
