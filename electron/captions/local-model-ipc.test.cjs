const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { registerCaptionIpc } = require('./register-caption-ipc');

function safeStatus({ available = true, meetingActive = false } = {}) {
  return {
    catalog: {
      available,
      error: available ? null : {
        code: 'local_catalog_unavailable',
        message: 'Local model downloads are unavailable in this build.',
      },
    },
    runtime: { ready: false, requestedDevice: 'NPU' },
    models: {
      'whisper-small': {
        id: 'whisper-small',
        displayName: 'Whisper Small',
        purpose: 'Transcription',
        expectedDevice: 'NPU',
        downloadBytes: 1,
        installedBytes: 0,
        downloadedBytes: 0,
        phase: available ? 'not-installed' : 'unavailable',
        ready: false,
        repairRecommended: false,
        error: available ? null : {
          code: 'local_catalog_unavailable',
          message: 'Local model downloads are unavailable in this build.',
        },
        actualDevice: null,
      },
      'hy-mt2-1.8b': {
        id: 'hy-mt2-1.8b',
        displayName: 'HY-MT2 1.8B',
        purpose: 'Translation',
        expectedDevice: 'GPU',
        downloadBytes: 2,
        installedBytes: 0,
        downloadedBytes: 0,
        phase: available ? 'not-installed' : 'unavailable',
        ready: false,
        repairRecommended: false,
        error: available ? null : {
          code: 'local_catalog_unavailable',
          message: 'Local model downloads are unavailable in this build.',
        },
        actualDevice: null,
      },
    },
    actionLocks: {
      meetingActive,
      download: meetingActive || !available,
      verify: meetingActive || !available,
      repair: meetingActive || !available,
      remove: meetingActive || !available,
    },
  };
}

function createHarness({ available = true, meetingActive = false } = {}) {
  const handlers = new Map();
  const broadcasts = [];
  const calls = [];
  const service = new EventEmitter();
  let status = safeStatus({ available, meetingActive });
  let confirmation = { response: 1 };
  service.status = () => status;
  for (const operation of ['install', 'verify', 'repair', 'remove']) {
    service[operation] = async (modelId) => {
      calls.push([operation, modelId]);
      if (modelId === 'unknown') {
        const error = new Error('https://private.invalid/C:\\secret');
        error.code = 'local_model_unknown';
        throw error;
      }
      if (meetingActive) {
        const error = new Error('C:\\meeting-active');
        error.code = 'meeting_active';
        throw error;
      }
      if (!available) {
        const error = new Error('https://private.invalid/catalog');
        error.code = 'local_catalog_unavailable';
        throw error;
      }
      return { modelId };
    };
  }
  const windows = {
    controlWindow: { isDestroyed: () => false, webContents: { id: 1 } },
    captionWindows: new Map(),
    cameraStageWindow: null,
    cameraOutputWindow: null,
    broadcast: (channel, payload) => broadcasts.push([channel, payload]),
    previewVisibility: () => ({}),
    cameraStageSnapshot: () => ({ status: {}, captions: [] }),
  };
  registerCaptionIpc({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      on() {},
    },
    app: { getPath: () => 'C:\\Documents', getVersion: () => 'test' },
    dialog: { showMessageBox: async () => confirmation },
    shell: {},
    windows,
    sessionManager: { snapshot: () => ({}), export: () => '', rateEvaluation() {}, setScreeningPrompt() {}, abortShadow() {}, start() {}, stop() {} },
    settingsStore: { get: () => ({}), set: () => ({}) },
    credentialStore: { status() {}, set() {}, delete() {}, validate() {} },
    evaluationRecorder: { list: () => [] },
    meetingRecordController: null,
    requestMicrophoneAccess: () => ({}),
    localModelService: service,
  });
  const invoke = (channel, payload, senderId = 1) =>
    handlers.get(channel)({ sender: { id: senderId } }, payload);
  return {
    broadcasts,
    calls,
    confirmation: (value) => { confirmation = value; },
    handlers,
    invoke,
    service,
    status: (value) => { status = value; },
  };
}

test('local-model IPC returns the renderer-safe status to trusted senders only', async () => {
  const harness = createHarness();

  const trusted = await harness.invoke('captions:local-model-status');
  const untrusted = await harness.invoke('captions:local-model-status', undefined, 99);

  assert.equal(trusted.ok, true);
  assert.deepEqual(trusted.data, safeStatus());
  assert.equal(untrusted.ok, false);
  assert.equal(untrusted.error.code, 'operation_failed');
});

test('local-model IPC safely returns unavailable and active action errors', async () => {
  const unavailable = createHarness({ available: false });
  const active = createHarness({ meetingActive: true });

  const unavailableResult = await unavailable.invoke('captions:local-model-install', {
    modelId: 'whisper-small',
  });
  const activeResult = await active.invoke('captions:local-model-verify', {
    modelId: 'whisper-small',
  });
  const unknownResult = await active.invoke('captions:local-model-repair', {
    modelId: 'unknown',
  });

  for (const result of [unavailableResult, activeResult, unknownResult]) {
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes('private.invalid'), false);
    assert.equal(JSON.stringify(result).includes('C:\\'), false);
  }
  assert.equal(unavailableResult.error.code, 'local_catalog_unavailable');
  assert.equal(activeResult.error.code, 'meeting_active');
  assert.equal(unknownResult.error.code, 'local_model_unknown');
});

test('local-model IPC invokes lifecycle actions and broadcasts each service status once', async () => {
  const harness = createHarness();

  assert.equal(harness.service.listenerCount('status'), 1);
  for (const [channel, operation] of [
    ['captions:local-model-install', 'install'],
    ['captions:local-model-verify', 'verify'],
    ['captions:local-model-repair', 'repair'],
  ]) {
    const result = await harness.invoke(channel, { modelId: 'whisper-small' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, safeStatus());
    assert.deepEqual(harness.calls.at(-1), [operation, 'whisper-small']);
  }

  const nextStatus = safeStatus();
  nextStatus.models['whisper-small'].phase = 'ready';
  nextStatus.models['whisper-small'].ready = true;
  harness.service.emit('status', nextStatus);
  assert.deepEqual(harness.broadcasts, [['captions:local-model-status', nextStatus]]);
});

test('local-model removal requires confirmation and cancellation returns safe status without mutation', async () => {
  const harness = createHarness();
  harness.confirmation({ response: 0 });

  const canceled = await harness.invoke('captions:local-model-remove', {
    modelId: 'whisper-small',
  });
  assert.deepEqual(canceled, { ok: true, data: { canceled: true, status: safeStatus() } });
  assert.deepEqual(harness.calls, []);

  harness.confirmation({ response: 1 });
  const removed = await harness.invoke('captions:local-model-remove', {
    modelId: 'whisper-small',
  });
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.data, { canceled: false, status: safeStatus() });
  assert.deepEqual(harness.calls, [['remove', 'whisper-small']]);
});

test('local-model removal sanitizes confirmation failures', async () => {
  const harness = createHarness();
  harness.confirmation(Promise.reject(Object.assign(
    new Error('https://private.invalid/C:\\dialog'),
    { code: 'EACCES' },
  )));
  // Keep the harness API concise while simulating Electron rejecting the modal.
  const original = harness.handlers.get('captions:local-model-remove');
  const result = await original({ sender: { id: 1 } }, { modelId: 'whisper-small' });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'local_model_operation_failed');
  assert.equal(JSON.stringify(result).includes('private.invalid'), false);
  assert.equal(JSON.stringify(result).includes('C:\\'), false);
});

test('the preload and renderer declarations expose only the local-model API', () => {
  const root = path.resolve(__dirname, '..', '..');
  const preload = fs.readFileSync(path.join(root, 'electron', 'captions-preload.js'), 'utf8');
  const declarations = fs.readFileSync(path.join(root, 'src', 'electron.d.ts'), 'utf8');
  const types = fs.readFileSync(path.join(root, 'src', 'captions', 'types.ts'), 'utf8');

  for (const text of [preload, declarations]) {
    assert.match(text, /getLocalModelStatus/);
    assert.match(text, /installLocalModel/);
    assert.match(text, /verifyLocalModel/);
    assert.match(text, /repairLocalModel/);
    assert.match(text, /removeLocalModel/);
    assert.match(text, /onLocalModelStatus/);
  }
  assert.match(preload, /captions:local-model-status/);
  assert.match(types, /export type LocalModelId/);
  assert.match(types, /export type LocalModelPhase/);
  assert.match(types, /export interface LocalModelStatus/);
});
