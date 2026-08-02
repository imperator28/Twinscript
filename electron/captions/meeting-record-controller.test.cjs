const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MeetingRecordController } = require('./meeting-record-controller');
const { EncryptedAudioWriter } = require('./encrypted-audio-writer');
const { RecordingKeyStore } = require('./recording-key-store');

function fakeApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-record-controller-'));
  const documents = path.join(root, 'Documents');
  const userData = path.join(root, 'AppData');
  fs.mkdirSync(documents, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  return {
    root,
    documents,
    app: { getPath: (name) => (name === 'documents' ? documents : userData) },
  };
}

function fakeSafeStorage({ available = true } = {}) {
  return {
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptStringAsync: async (buffer) => ({
      result: buffer.toString('utf8').replace(/^enc:/, ''),
    }),
  };
}

function fakeSettingsStore(overrides = {}) {
  const settings = {
    autoSaveTranscript: true,
    meetingRecordsDirectory: null,
    keepAudioAutomatically: false,
    glossaryConfigurationId: 'south-china-tooling',
    primaryProfile: 'economy',
    ...overrides,
  };
  return { get: () => settings, settings };
}

function controllerFor({ app, safeStorage, settingsStore, sampleRate = 100, now } = {}) {
  const built = app || fakeApp();
  return {
    ...built,
    settingsStore: settingsStore || fakeSettingsStore(),
    controller: new MeetingRecordController({
      app: built.app,
      safeStorage: safeStorage || fakeSafeStorage(),
      settingsStore: settingsStore || fakeSettingsStore(),
      sampleRate,
      now: now || (() => 1_700_000_060_000),
      logger: { warn() {}, error() {} },
    }),
  };
}

function captionEvent(overrides = {}) {
  return {
    sequence: 1,
    sourceStartedAt: 1_700_000_000_000,
    firstTranscriptAt: 1_700_000_000_000,
    sourceChannel: 'microphone',
    sourceLanguage: 'en',
    sourceText: 'We need T2 by Friday.',
    english: { text: 'We need T2 by Friday.', status: 'final' },
    chinese: { text: '我们星期五之前需要 T2。', status: 'final' },
    ...overrides,
  };
}

const STARTED_AT = 1_700_000_000_000;

async function startedSession(overrides = {}) {
  const built = controllerFor(overrides.controllerOptions);
  const result = await built.controller.startSession({
    sessionId: overrides.sessionId || 'session-1',
    startedAt: overrides.startedAt || STARTED_AT,
    settings: built.settingsStore.settings,
  });
  return { ...built, result };
}

test('starting a session creates the visible directory and a pending manifest', async () => {
  const { controller, documents, result } = await startedSession();
  assert.equal(result.recording, true);
  assert.equal(fs.existsSync(result.sessionDir), true);
  assert.ok(result.sessionDir.startsWith(path.join(documents, 'Twinscript')));
  const pendingManifest = controller.readPendingManifest('session-1');
  assert.equal(pendingManifest.sessionDir, result.sessionDir);
});

test('autoSaveTranscript off still captures encrypted temporary audio without saving captions', async () => {
  const settingsStore = fakeSettingsStore({ autoSaveTranscript: false });
  const { controller } = controllerFor({ settingsStore });

  const result = await controller.startSession({
    sessionId: 'no-record',
    startedAt: STARTED_AT,
    settings: settingsStore.settings,
  });

  assert.equal(result.recording, true);
  controller.writeAudioChunk('microphone', Int16Array.from([1]), STARTED_AT, 10);
  controller.appendFinalRecord(captionEvent());
  const stopped = await controller.stopSession();
  assert.equal(stopped.session.audioRetention, 'pending');
  assert.equal(fs.existsSync(path.join(result.sessionDir, 'session.json')), true);
  assert.equal(fs.existsSync(path.join(result.sessionDir, 'transcript.jsonl')), false);
  assert.equal(fs.existsSync(path.join(result.sessionDir, 'transcript.json')), false);
  assert.equal(fs.existsSync(path.join(result.sessionDir, 'transcript.md')), false);
});

test('a full session round trip: audio + transcript + stop leaves the decision pending', async () => {
  const { controller, result } = await startedSession();
  controller.writeAudioChunk('microphone', Int16Array.from(new Array(50).fill(5)), STARTED_AT, 500);
  controller.writeAudioChunk('system', Int16Array.from(new Array(20).fill(9)), STARTED_AT, 200);
  controller.appendFinalRecord(captionEvent());

  const stopped = await controller.stopSession({ appVersion: '0.1.0', estimatedCostUsd: 0.05 });

  assert.equal(stopped.session.audioRetention, 'pending');
  assert.equal(stopped.session.channelAvailability.microphone, true);
  assert.equal(stopped.session.channelAvailability.system, true);
  assert.equal(stopped.session.captionCount, 1);

  const transcript = JSON.parse(
    fs.readFileSync(path.join(result.sessionDir, 'transcript.json'), 'utf8'),
  );
  assert.equal(transcript.records[0].english, 'We need T2 by Friday.');
  assert.equal(transcript.records[0].chinese, '我们星期五之前需要 T2。');

  // Pending encrypted audio still exists — nothing has been decided yet.
  assert.equal(fs.existsSync(controller.pendingChunkPath('session-1', 'microphone')), true);
  assert.equal(fs.existsSync(controller.pendingChunkPath('session-1', 'system')), true);
});

test('a session with no audio on either channel is marked unavailable and cleaned up', async () => {
  const { controller, result } = await startedSession();
  const stopped = await controller.stopSession();
  assert.equal(stopped.session.audioRetention, 'unavailable');
  assert.equal(fs.existsSync(controller.pendingDir('session-1')), false);
  assert.equal(fs.existsSync(result.sessionDir), true); // the transcript record itself remains
});

test('keep finalizes both channels into WAV files and clears the pending decision', async () => {
  const { controller, result } = await startedSession();
  controller.writeAudioChunk('microphone', Int16Array.from(new Array(50).fill(3)), STARTED_AT, 500);
  controller.writeAudioChunk('system', Int16Array.from(new Array(50).fill(4)), STARTED_AT, 500);
  await controller.stopSession();

  const kept = await controller.keep('session-1');

  assert.equal(kept.session.audioRetention, 'kept');
  assert.equal(fs.existsSync(path.join(result.sessionDir, 'microphone.wav')), true);
  assert.equal(fs.existsSync(path.join(result.sessionDir, 'meeting-audio.wav')), true);
  assert.equal(fs.existsSync(controller.pendingDir('session-1')), false);
});

test('keep is idempotent: a second call returns the existing kept state without redoing work', async () => {
  const { controller, result } = await startedSession();
  controller.writeAudioChunk('microphone', Int16Array.from([1, 2, 3]), STARTED_AT, 100);
  await controller.stopSession();
  const first = await controller.keep('session-1');
  const wavStat = fs.statSync(path.join(result.sessionDir, 'microphone.wav'));

  const second = await controller.keep('session-1');

  assert.deepEqual(second.session, first.session);
  assert.equal(
    fs.statSync(path.join(result.sessionDir, 'microphone.wav')).mtimeMs,
    wavStat.mtimeMs,
    'the file was not rewritten',
  );
});

test('discard removes the encrypted audio without producing WAV files', async () => {
  const { controller, result } = await startedSession();
  controller.writeAudioChunk('microphone', Int16Array.from([1, 2, 3]), STARTED_AT, 100);
  await controller.stopSession();

  const discarded = await controller.discard('session-1');

  assert.equal(discarded.session.audioRetention, 'discarded');
  assert.equal(fs.existsSync(path.join(result.sessionDir, 'microphone.wav')), false);
  assert.equal(fs.existsSync(controller.pendingDir('session-1')), false);
});

test('discard after discard returns the same terminal state, found by session ID', async () => {
  const { controller } = await startedSession();
  controller.writeAudioChunk('microphone', Int16Array.from([1]), STARTED_AT, 10);
  await controller.stopSession();
  const first = await controller.discard('session-1');
  // The pending manifest is gone now; the fallback lookup by session ID must
  // still find the terminal state rather than erroring or re-discarding.
  const second = await controller.discard('session-1');
  assert.deepEqual(second.session, first.session);
});

test('keeping a session after it was already discarded does not resurrect it', async () => {
  const { controller } = await startedSession();
  controller.writeAudioChunk('microphone', Int16Array.from([1]), STARTED_AT, 10);
  await controller.stopSession();
  await controller.discard('session-1');

  const kept = await controller.keep('session-1');
  assert.equal(kept.session.audioRetention, 'discarded');
});

test('keeping or discarding an unknown session ID is a safe no-op', async () => {
  const { controller } = await startedSession();
  assert.deepEqual(await controller.keep('never-existed'), { recording: false });
  assert.deepEqual(await controller.discard('never-existed'), { recording: false });
});

test('keepAudioAutomatically finalizes audio as part of stopping the session', async () => {
  const { controller, result } = await startedSession({
    controllerOptions: {
      settingsStore: fakeSettingsStore({ keepAudioAutomatically: true }),
    },
  });
  controller.writeAudioChunk('microphone', Int16Array.from(new Array(20).fill(1)), STARTED_AT, 200);

  const stopped = await controller.stopSession();

  assert.equal(stopped.session.audioRetention, 'kept');
  assert.equal(fs.existsSync(path.join(result.sessionDir, 'microphone.wav')), true);
});

test('a channel that never captured anything is reported missing, not failed, and does not block keep', async () => {
  const { controller, result } = await startedSession();
  // Only the microphone channel ever writes a chunk — loopback failed for the
  // whole meeting.
  controller.writeAudioChunk('microphone', Int16Array.from(new Array(30).fill(2)), STARTED_AT, 300);
  await controller.stopSession();

  const kept = await controller.keep('session-1');

  assert.equal(kept.session.audioRetention, 'kept');
  assert.equal(kept.session.audioTracks.microphone.status, 'written');
  assert.equal(kept.session.audioTracks.system.status, 'missing');
  assert.equal(fs.existsSync(path.join(result.sessionDir, 'meeting-audio.wav')), false);
});

test('a missing encryption key skips audio backup but keeps the transcript intact', async () => {
  const { controller, result } = await startedSession({
    controllerOptions: { safeStorage: fakeSafeStorage({ available: false }) },
  });
  // No writer exists for either channel; this must not throw.
  controller.writeAudioChunk('microphone', Int16Array.from([1, 2, 3]), STARTED_AT, 30);
  controller.appendFinalRecord(captionEvent());

  const stopped = await controller.stopSession();

  assert.equal(stopped.session.audioRetention, 'unavailable');
  assert.equal(stopped.session.captionCount, 1);
  assert.equal(fs.existsSync(path.join(result.sessionDir, 'transcript.json')), true);
});

test('a crash before stopSession is recovered at the next launch', async () => {
  const built = controllerFor();
  const { controller, app } = built;
  const startResult = await controller.startSession({
    sessionId: 'crashed-session',
    startedAt: STARTED_AT,
    settings: fakeSettingsStore().settings,
  });
  const key = await new RecordingKeyStore({ app, safeStorage: fakeSafeStorage() }).getKey();
  const writer = new EncryptedAudioWriter({
    filePath: controller.pendingChunkPath('crashed-session', 'microphone'),
    key,
    sessionId: 'crashed-session',
    channel: 'microphone',
  });
  writer.write(Int16Array.from(new Array(10).fill(7)), STARTED_AT, 100);
  await writer.finish();
  // The process ends here without ever calling stopSession — no session.json,
  // no transcript.json, exactly like a crash or forced quit.
  assert.equal(fs.existsSync(path.join(startResult.sessionDir, 'session.json')), false);

  const freshController = new MeetingRecordController({
    app,
    safeStorage: fakeSafeStorage(),
    settingsStore: fakeSettingsStore(),
    sampleRate: 100,
    now: () => 1_700_000_100_000,
    logger: { warn() {}, error() {} },
  });
  const pending = await freshController.recoverPendingSessions({ appVersion: '0.1.0' });

  assert.equal(pending.length, 1);
  assert.equal(pending[0].sessionId, 'crashed-session');
  assert.equal(pending[0].session.audioRetention, 'pending');
  assert.equal(pending[0].session.channelAvailability.microphone, true);
  assert.equal(pending[0].session.channelAvailability.system, false);
  assert.equal(
    fs.existsSync(path.join(startResult.sessionDir, 'transcript.json')),
    true,
  );

  // The recovered session can still be kept normally afterward.
  const kept = await freshController.keep('crashed-session');
  assert.equal(kept.session.audioRetention, 'kept');
  assert.equal(fs.existsSync(path.join(startResult.sessionDir, 'microphone.wav')), true);
});

test('a crash with no audio on either channel is cleaned up without appearing pending', async () => {
  const { controller, app } = controllerFor();
  await controller.startSession({
    sessionId: 'empty-crash',
    startedAt: STARTED_AT,
    settings: fakeSettingsStore().settings,
  });
  // No audio chunk ever written for either channel before the simulated crash.

  const freshController = new MeetingRecordController({
    app,
    safeStorage: fakeSafeStorage(),
    settingsStore: fakeSettingsStore(),
    sampleRate: 100,
    logger: { warn() {}, error() {} },
  });
  const pending = await freshController.recoverPendingSessions();

  assert.deepEqual(pending, []);
  assert.equal(fs.existsSync(controller.pendingDir('empty-crash')), false);
});

test('recovery with no pending-audio directory at all returns an empty list', async () => {
  const { controller } = controllerFor();
  assert.deepEqual(await controller.recoverPendingSessions(), []);
});

test('honors a user-selected records directory over the default', async () => {
  const built = fakeApp();
  const customDir = path.join(built.root, 'CustomRecords');
  const settingsStore = fakeSettingsStore({ meetingRecordsDirectory: customDir });
  const controller = new MeetingRecordController({
    app: built.app,
    safeStorage: fakeSafeStorage(),
    settingsStore,
    sampleRate: 100,
    logger: { warn() {}, error() {} },
  });
  const result = await controller.startSession({
    sessionId: 'custom-dir',
    startedAt: STARTED_AT,
    settings: settingsStore.settings,
  });
  assert.ok(result.sessionDir.startsWith(customDir));
});
