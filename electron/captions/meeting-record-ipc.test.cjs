const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerCaptionIpc } = require('./register-caption-ipc');

function createHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-record-ipc-'));
  const sourceDir = path.join(root, 'source');
  const chosenDir = path.join(root, 'chosen');
  const exportedPath = path.join(root, 'exported.md');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'transcript.md'), '# Saved meeting\n');

  const handlers = new Map();
  const calls = [];
  let overlaysVisible = false;
  let cameraStageVisible = false;
  let settings = {
    meetingRecordsDirectory: null,
    autoSaveTranscript: true,
    keepAudioAutomatically: false,
    captionHistoryEntries: 3,
    captionOverlayHeight: 240,
  };
  const pending = {
    sessionId: 'session-123',
    sessionDir: sourceDir,
    session: { sessionId: 'session-123', audioRetention: 'pending' },
  };
  const windows = {
    controlWindow: {
      isDestroyed: () => false,
      webContents: { id: 10 },
    },
    captionWindows: new Map([
      [
        'en',
        {
          isDestroyed: () => false,
          webContents: { id: 11 },
        },
      ],
    ]),
    cameraStageWindow: {
      isDestroyed: () => false,
      webContents: { id: 12 },
    },
    broadcast: (channel, payload) => calls.push(['broadcast', channel, payload]),
    showAll: () => {
      overlaysVisible = true;
      calls.push(['show-all']);
    },
    hideAll: () => {
      overlaysVisible = false;
    },
    applySelectedOutput: () => calls.push(['apply-selected-output']),
    previewVisibility: () => ({ overlaysVisible, cameraStageVisible }),
    showCameraStage: () => {
      cameraStageVisible = true;
      calls.push(['show-camera-stage']);
    },
    hideCameraStage: () => {
      cameraStageVisible = false;
      calls.push(['hide-camera-stage']);
    },
    cameraStageSnapshot: () => ({
      status: { state: 'running', sessionId: 'session-1' },
      captions: [],
    }),
    applyLayout: () => {},
    autoSizeGeneration: 3,
    reportContentHeight: (audience, height, generation) => {
      calls.push(['height', audience, height, generation]);
      return Math.round(height);
    },
    applySettings: (next) => calls.push(['apply-settings', next]),
    resetAutoSize: () => {
      calls.push(['reset-auto-size']);
      settings = { ...settings, captionOverlayHeight: null };
      return settings;
    },
    resetContentMeasurements: () => {
      calls.push(['reset-content-measurements']);
      return settings;
    },
  };
  const meetingRecordController = {
    recoverPendingSessions: async () => [pending],
    keep: async (sessionId) => {
      calls.push(['keep', sessionId]);
      return { ...pending, session: { ...pending.session, audioRetention: 'kept' } };
    },
    discard: async (sessionId) => {
      calls.push(['discard', sessionId]);
      return {
        ...pending,
        session: { ...pending.session, audioRetention: 'discarded' },
      };
    },
    resolvePendingOrTerminal: (sessionId) =>
      sessionId === pending.sessionId
        ? { manifest: pending }
        : { terminal: { recording: false } },
  };

  registerCaptionIpc({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      on: () => {},
    },
    app: {
      getPath: () => root,
      getVersion: () => '0.1.0-test',
    },
    dialog: {
      showOpenDialog: async (_window, options) => {
        calls.push(['open-dialog', options]);
        return { canceled: false, filePaths: [chosenDir] };
      },
      showSaveDialog: async (_window, options) => {
        calls.push(['save-dialog', options]);
        return { canceled: false, filePath: exportedPath };
      },
      showMessageBox: async () => ({ response: 0 }),
    },
    shell: {
      openExternal: async () => {},
      openPath: async (target) => {
        calls.push(['open-path', target]);
        return '';
      },
    },
    windows,
    sessionManager: {
      snapshot: () => ({}),
      export: () => '',
      rateEvaluation: () => ({}),
      setScreeningPrompt: () => null,
      abortShadow: () => ({}),
      start: async () => ({}),
      stop: async () => ({}),
    },
    settingsStore: {
      get: () => settings,
      set: (patch) => {
        settings = { ...settings, ...patch };
        return settings;
      },
    },
    credentialStore: {
      status: () => ({}),
      set: () => ({}),
      delete: () => ({}),
      repair: () => ({}),
      validate: () => ({}),
    },
    evaluationRecorder: { list: () => [] },
    meetingRecordController,
    requestMicrophoneAccess: () => ({}),
  });

  return {
    root,
    sourceDir,
    chosenDir,
    exportedPath,
    handlers,
    calls,
    trustedEvent: { sender: { id: 10 } },
    stageEvent: { sender: { id: 12 } },
    untrustedEvent: { sender: { id: 99 } },
  };
}

test('camera-stage IPC can show and hide only from trusted app windows', async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  const shown = await harness.handlers.get('captions:camera-stage-show')(
    harness.trustedEvent,
  );
  const hidden = await harness.handlers.get('captions:camera-stage-hide')(
    harness.stageEvent,
  );
  const snapshot = await harness.handlers.get('captions:camera-stage-snapshot')(
    harness.stageEvent,
  );
  const rejected = await harness.handlers.get('captions:camera-stage-show')(
    harness.untrustedEvent,
  );

  assert.equal(shown.ok, true);
  assert.deepEqual(shown.data, {
    overlaysVisible: false,
    cameraStageVisible: true,
  });
  assert.equal(hidden.ok, true);
  assert.deepEqual(hidden.data, {
    overlaysVisible: false,
    cameraStageVisible: false,
  });
  assert.deepEqual(snapshot.data, {
    status: { state: 'running', sessionId: 'session-1' },
    captions: [],
  });
  assert.deepEqual(harness.calls.slice(-2), [
    ['show-camera-stage'],
    ['hide-camera-stage'],
  ]);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error.message, /Untrusted/);
});

test('session start applies only the selected output family', async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  const started = await harness.handlers.get('captions:session-start')(
    harness.trustedEvent,
    {},
  );

  assert.equal(started.ok, true);
  assert.equal(
    harness.calls.some((call) => call[0] === 'apply-selected-output'),
    true,
  );
  assert.equal(harness.calls.some((call) => call[0] === 'show-all'), false);
});

test('preview visibility IPC returns the authoritative native snapshot', async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  const result = await harness.handlers.get('captions:preview-visibility-get')(
    harness.trustedEvent,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, {
    overlaysVisible: false,
    cameraStageVisible: false,
  });
});

test('changing visible history preserves the manual overlay height floor', async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  const result = await harness.handlers.get('captions:settings-set')(
    harness.trustedEvent,
    { captionHistoryEntries: 10 },
  );

  assert.equal(result.ok, true);
  assert.equal(result.data.captionHistoryEntries, 10);
  assert.equal(result.data.captionOverlayHeight, 240);
  assert.equal(
    harness.calls.some(([name]) => name === 'reset-content-measurements'),
    true,
  );
  assert.equal(
    harness.calls.some(([name]) => name === 'reset-auto-size'),
    false,
  );
});

test('layout IPC persists the sanitized layout and broadcasts its settings payload', async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  const result = await harness.handlers.get('captions:layout-set')(
    harness.trustedEvent,
    { layout: 'side-by-side' },
  );

  assert.equal(result.ok, true);
  assert.equal(result.data.layout, 'side-by-side');
  assert.equal(
    harness.calls.some(
      ([name, channel, payload]) =>
        name === 'broadcast' &&
        channel === 'captions:settings' &&
        payload.layout === 'side-by-side',
    ),
    true,
  );
  assert.equal(
    harness.calls.some(
      ([name, settings]) =>
        name === 'apply-settings' && settings.layout === 'side-by-side',
    ),
    true,
  );
});

test('meeting-record IPC exposes only validated owner actions', async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  const choose = await harness.handlers.get(
    'captions:meeting-records-directory-choose',
  )(harness.trustedEvent);
  assert.equal(choose.ok, true);
  assert.equal(choose.data.directory, harness.chosenDir);
  assert.equal(choose.data.settings.meetingRecordsDirectory, harness.chosenDir);

  const pending = await harness.handlers.get(
    'captions:meeting-records-pending',
  )(harness.trustedEvent);
  assert.equal(pending.ok, true);
  assert.equal(pending.data[0].sessionId, 'session-123');

  const kept = await harness.handlers.get('captions:meeting-record-keep')(
    harness.trustedEvent,
    { sessionId: 'session-123' },
  );
  assert.equal(kept.ok, true);
  assert.equal(kept.data.session.audioRetention, 'kept');

  const discarded = await harness.handlers.get('captions:meeting-record-discard')(
    harness.trustedEvent,
    { sessionId: 'session-123' },
  );
  assert.equal(discarded.ok, true);
  assert.equal(discarded.data.session.audioRetention, 'discarded');

  const invalid = await harness.handlers.get('captions:meeting-record-keep')(
    harness.trustedEvent,
    { sessionId: '..\\outside' },
  );
  assert.equal(invalid.ok, false);
  assert.match(invalid.error.message, /Invalid meeting session/);

  const revealed = await harness.handlers.get('captions:meeting-record-reveal')(
    harness.trustedEvent,
    { sessionId: 'session-123' },
  );
  assert.equal(revealed.ok, true);
  assert.deepEqual(
    harness.calls.find(([name]) => name === 'open-path'),
    ['open-path', harness.sourceDir],
  );

  const exported = await harness.handlers.get('captions:meeting-record-export')(
    harness.trustedEvent,
    { sessionId: 'session-123' },
  );
  assert.equal(exported.ok, true);
  assert.equal(
    fs.readFileSync(harness.exportedPath, 'utf8'),
    '# Saved meeting\n',
  );

  const rejected = await harness.handlers.get(
    'captions:meeting-records-pending',
  )(harness.untrustedEvent);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error.message, /Untrusted IPC sender/);

  const height = await harness.handlers.get('captions:overlay-content-height')(
    { sender: { id: 11 } },
    { audience: 'en', height: 248.4, generation: 3 },
  );
  assert.deepEqual(height, {
    ok: true,
    data: { audience: 'en', height: 248, generation: 3 },
  });
  const wrongWindow = await harness.handlers.get(
    'captions:overlay-content-height',
  )(harness.trustedEvent, { audience: 'en', height: 200, generation: 3 });
  assert.equal(wrongWindow.ok, false);
  assert.match(wrongWindow.error.message, /audience window/);

  const missingGeneration = await harness.handlers.get(
    'captions:overlay-content-height',
  )({ sender: { id: 11 } }, { audience: 'en', height: 200 });
  assert.equal(missingGeneration.ok, false);
  assert.match(missingGeneration.error.message, /generation/);
});
