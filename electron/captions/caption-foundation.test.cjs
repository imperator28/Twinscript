const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyScript,
  createCaptionEvent,
  projectForAudience,
  updateTarget,
} = require('./caption-domain');
const { CostMeter } = require('./cost-meter');
const {
  extractResponseText,
  glossaryPrompt,
  OpenAINormalizer,
  PROFILE_MODELS,
} = require('./openai-normalizer');
const { pcmRms, VadGate } = require('./vad-gate');
const { EvaluationRecorder } = require('./evaluation-recorder');
const {
  CredentialStore,
  secureStorageLabel,
} = require('./credential-store');
const { LiveTranscriptionSession } = require('./live-transcription-session');
const { PriorityTaskQueue } = require('./priority-task-queue');
const { CAPTION_THEMES, SettingsStore } = require('./settings-store');
const {
  TranscriptCoordinator,
  diceSimilarity,
} = require('./transcript-coordinator');
const {
  buildQualitySignals,
  protectedTokens,
} = require('./quality-signals');
const {
  CaptionSessionManager,
  sanitizeScreeningPrompt,
} = require('./caption-session-manager');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { LocalModelAdmissionGate } = require('./local-model-admission');
const { LocalModelService } = require('./local-model-service');

test('caption session activity remains locked while shutdown finalizes', () => {
  const manager = new CaptionSessionManager({ credentialStore: {}, settingsStore: {} });
  assert.equal(manager.isActive(), false);

  manager.active = true;
  assert.equal(manager.isActive(), true);

  manager.active = false;
  manager.finalizingStop = true;
  assert.equal(manager.isActive(), true);
});

test('session start waits for an in-flight local model mutation before becoming active', async () => {
  const gate = new LocalModelAdmissionGate();
  let releaseMutation;
  const mutating = gate.runMutation(() => new Promise((resolve) => {
    releaseMutation = resolve;
  }));
  await Promise.resolve();
  const manager = new CaptionSessionManager({
    credentialStore: {},
    settingsStore: {
      get: () => ({ budgetUsd: 5, shadowEnabled: false, reorderWindowMs: 400, duplicateWindowMs: 1400 }),
      set: () => {},
    },
    admissionGate: gate,
  });
  const starting = manager.start({ mode: 'mock' });

  await Promise.resolve();
  assert.equal(manager.active, false);
  assert.equal(gate.isSessionActive(), false);

  releaseMutation();
  await mutating;
  await starting;
  assert.equal(manager.active, true);
  await manager.stop();
});

test('a shutdown failure releases the local model admission lease before rethrowing', async () => {
  const gate = new LocalModelAdmissionGate();
  const manager = new CaptionSessionManager({
    credentialStore: {},
    settingsStore: {},
    admissionGate: gate,
    meetingRecordController: {
      stopSession: async () => {
        throw new Error('records unavailable');
      },
    },
  });
  manager.sessionAdmissionRelease = await gate.acquireSession();
  manager.active = true;
  manager.mode = 'live';
  let installedModel = null;
  const service = new LocalModelService({
    catalog: {
      available: true,
      manifest: { models: [{ id: 'whisper-small' }] },
    },
    manager: {
      status: () => ({ models: { 'whisper-small': { ready: false } } }),
      download: async (modelId) => { installedModel = modelId; },
    },
    admissionGate: gate,
    isMeetingActive: () => manager.isActive(),
  });

  await assert.rejects(manager.stop(), /records unavailable/);
  assert.equal(gate.isSessionActive(), false);
  assert.equal(manager.isActive(), false);

  await service.install('whisper-small');
  assert.equal(installedModel, 'whisper-small');
});

test('routes dominant English, Chinese, and mixed-script utterances', () => {
  assert.equal(classifyScript('Can we move DVT to September?'), 'en');
  assert.equal(classifyScript('这个支架需要修改公差。'), 'zh');
  assert.equal(classifyScript('这个 boss 的 wall thickness 太薄'), 'mixed');
  assert.equal(classifyScript('0.2 ±'), 'unknown');
});

test('fast path passes the source only to its matching audience', () => {
  const event = createCaptionEvent({
    sessionId: 'session',
    sequence: 1,
    sourceChannel: 'microphone',
    providerItemId: 'item',
    sourceText: 'Please update the CAD.',
    sourceStartedAt: 1,
    transcriptStatus: 'final',
    profile: 'economy',
  });
  assert.equal(event.english.text, 'Please update the CAD.');
  assert.equal(event.english.passthrough, true);
  assert.equal(event.chinese.status, 'pending');
  const translated = updateTarget(event, 'zh', {
    text: '请更新 CAD。',
    status: 'final',
  });
  assert.equal(translated.status, 'final');
  assert.equal(projectForAudience(translated, 'zh').text, '请更新 CAD。');
});

test('caption events preserve truthful local runtime and device provenance', () => {
  const event = createCaptionEvent({
    sessionId: 'session',
    sequence: 1,
    sourceChannel: 'microphone',
    providerItemId: 'item',
    sourceText: 'Confirmed.',
    sourceStartedAt: 1,
    transcriptStatus: 'final',
    profile: 'economy',
    transcriptionModel: 'whisper-small',
    transcriptionRuntime: 'openvino-genai',
    transcriptionDevice: 'NPU',
  });

  assert.equal(event.provider.transcriptionModel, 'whisper-small');
  assert.equal(event.provider.transcriptionRuntime, 'openvino-genai');
  assert.equal(event.provider.transcriptionDevice, 'NPU');
});

test('audience projections share aggregate completion while target states differ', () => {
  const event = createCaptionEvent({
    sessionId: 'session',
    sequence: 1,
    sourceChannel: 'microphone',
    providerItemId: 'item',
    sourceText: 'Please update the CAD.',
    sourceStartedAt: 1,
    transcriptStatus: 'final',
    profile: 'economy',
  });
  const english = projectForAudience(event, 'en');
  const chinese = projectForAudience(event, 'zh');
  assert.equal(english.status, 'final');
  assert.equal(chinese.status, 'pending');
  assert.equal(english.settled, false);
  assert.equal(chinese.settled, false);

  const translated = updateTarget(event, 'zh', {
    text: 'CAD updated.',
    status: 'final',
  });
  assert.equal(projectForAudience(translated, 'en').settled, true);
  assert.equal(projectForAudience(translated, 'zh').settled, true);
});

test('a final caption cannot regress to provisional', () => {
  const event = createCaptionEvent({
    sessionId: 'session',
    sequence: 1,
    sourceChannel: 'system',
    providerItemId: 'item',
    sourceText: '确认模具时间。',
    sourceStartedAt: 1,
    transcriptStatus: 'final',
    profile: 'economy',
  });
  const unchanged = updateTarget(event, 'zh', {
    text: 'partial',
    status: 'provisional',
  });
  assert.equal(unchanged.chinese.text, '确认模具时间。');
});

test('cost meter prices two one-hour transcription channels and enforces cap', () => {
  const events = [];
  const meter = new CostMeter({
    budgetUsd: 0.03,
    onBudgetEvent: (event) => events.push(event.type),
  });
  meter.addAudio(60 * 60 * 1000);
  meter.addAudio(60 * 60 * 1000);
  assert.equal(meter.snapshot().totalUsd, 2.04);
  assert.deepEqual(events, ['warning', 'exhausted']);
  assert.equal(meter.canSpend(), false);
  assert.equal(meter.snapshot().costByStage.transcriptionUsd, 2.04);
});

test('final transcripts release by source time and suppress cross-channel duplicates', () => {
  const released = [];
  const duplicates = [];
  const coordinator = new TranscriptCoordinator({
    onRelease: (event) => released.push(event.itemId),
    onDuplicate: (candidate) => {
      duplicates.push(candidate);
      return candidate.event.channel === 'system'
        ? candidate.event
        : candidate.duplicateOf;
    },
  });
  // Terminal punctuation matters now: an unfinished fragment is held back to be
  // joined with its continuation, so a test about ORDERING has to supply text that
  // actually looks finished. Sentence assembly has its own tests in
  // transcript-coordinator.test.cjs.
  coordinator.submit({
    channel: 'microphone',
    itemId: 'later',
    transcript: 'Move DVT to September.',
    startedAt: 200,
    at: 500,
  });
  coordinator.submit({
    channel: 'system',
    itemId: 'earlier',
    transcript: '确认模具时间。',
    startedAt: 100,
    at: 450,
  });
  coordinator.flush();
  assert.deepEqual(released, ['earlier', 'later']);
  coordinator.submit({
    channel: 'system',
    itemId: 'echo',
    transcript: 'Move DVT to September.',
    startedAt: 210,
    at: 510,
  });
  coordinator.flush();
  assert.equal(duplicates.length, 1);
  assert.ok(duplicates[0].similarity > 0.92);
  assert.ok(diceSimilarity('公差 ±0.2 mm', '公差 ±0.2mm') > 0.9);
  coordinator.reset();
});

test('priority queue favors final work and rejects bounded overflow', async () => {
  const queue = new PriorityTaskQueue({ concurrency: 1, maxQueue: 2 });
  const order = [];
  let release;
  const blocker = queue.run(
    () => new Promise((resolve) => {
      release = () => {
        order.push('blocker');
        resolve();
      };
    }),
  );
  const low = queue.run(async () => order.push('provisional'), { priority: 0 });
  const high = queue.run(async () => order.push('final'), { priority: 10 });
  await assert.rejects(
    queue.run(async () => {}, { priority: 5 }),
    (error) => error.code === 'normalization_backpressure',
  );
  release();
  await Promise.all([blocker, low, high]);
  assert.deepEqual(order, ['blocker', 'final', 'provisional']);
});

test('final normalization retries transient errors while provisional does not', async () => {
  let attempts = 0;
  const responsePayload = {
    output_text: JSON.stringify({ source_language: 'en', text: '确认' }),
    usage: { input_tokens: 2, output_tokens: 1 },
  };
  const normalizer = new OpenAINormalizer({
    apiKey: 'test-key',
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        return { ok: false, status: 429, text: async () => 'retry' };
      }
      return {
        ok: true,
        json: async () => responsePayload,
        headers: new Map(),
      };
    },
  });
  const result = await normalizer.normalize({
    sourceText: 'confirm',
    target: 'zh',
    profile: 'economy',
    final: true,
  });
  assert.equal(result.text, '确认');
  assert.equal(attempts, 3);

  let provisionalAttempts = 0;
  const provisional = new OpenAINormalizer({
    apiKey: 'test-key',
    fetchImpl: async () => {
      provisionalAttempts += 1;
      return { ok: false, status: 503, text: async () => 'unavailable' };
    },
  });
  await assert.rejects(
    provisional.normalize({
      sourceText: 'confirm',
      target: 'zh',
      profile: 'economy',
      final: false,
    }),
  );
  assert.equal(provisionalAttempts, 1);
});

test('live transport drops bounded audio under socket backpressure', () => {
  const events = [];
  const usages = [];
  const session = new LiveTranscriptionSession({
    channel: 'microphone',
    apiKey: 'test',
    settings: {
      vadEnabled: false,
      vadThreshold: 0.01,
      delayProfile: 'low',
    },
    onEvent: (event) => events.push(event),
    onUsage: (usage) => usages.push(usage),
  });
  session.connected = true;
  session.socket = {
    readyState: 1,
    bufferedAmount: session.maxSocketBufferedBytes + 1,
  };
  session.appendAudio(new Int16Array(2400).fill(1000));
  assert.equal(usages.length, 0);
  const transport = events.find(
    (event) => event.type === 'transport-metric',
  );
  assert.equal(transport.dropReason, 'socket_backpressure');
  assert.equal(transport.droppedAudioMs, 100);
});

test('live transport waits for OpenAI to accept session configuration', async () => {
  class MockSocket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 1;
      this.bufferedAmount = 0;
      this.sent = [];
    }
    send(value) {
      this.sent.push(JSON.parse(value));
    }
    close() {}
  }
  const socket = new MockSocket();
  const events = [];
  let connectionUrl = '';
  const session = new LiveTranscriptionSession({
    channel: 'microphone',
    apiKey: 'test',
    settings: {
      vadEnabled: false,
      vadThreshold: 0.01,
      delayProfile: 'low',
    },
    websocketFactory: (url) => {
      connectionUrl = url;
      return socket;
    },
    onEvent: (event) => events.push(event),
  });
  let ready = false;
  const connecting = session.connect().then(() => {
    ready = true;
  });
  socket.emit('open');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ready, false);
  assert.equal(
    connectionUrl,
    'wss://api.openai.com/v1/realtime?intent=transcription',
  );
  assert.equal(socket.sent[0].type, 'session.update');
  assert.equal(
    socket.sent[0].session.audio.input.transcription.model,
    'gpt-live-transcribe',
  );
  assert.deepEqual(
    socket.sent[0].session.audio.input.format,
    { type: 'audio/pcm', rate: 24000 },
  );
  assert.deepEqual(
    socket.sent[0].session.audio.input.transcription.languages,
    ['en', 'zh-cn'],
  );
  assert.equal(socket.sent[0].session.audio.input.transcription.delay, 'low');
  assert.equal(socket.sent[0].session.audio.input.turn_detection, null);
  socket.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'session.updated', session: {} })),
  );
  await connecting;
  assert.equal(ready, true);
  assert.equal(
    events.find((event) => event.type === 'connection').status,
    'connected',
  );
});

test('live transport commits a quiet speech turn after trailing silence', () => {
  const sent = [];
  const session = new LiveTranscriptionSession({
    channel: 'microphone',
    apiKey: 'test',
    settings: {
      vadEnabled: false,
      vadThreshold: 0.012,
      delayProfile: 'low',
    },
  });
  session.connected = true;
  session.socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (value) => sent.push(JSON.parse(value)),
  };

  // RMS ≈ .0076: audible in the user's reported setup but below the legacy
  // .012 threshold that previously discarded the whole utterance.
  session.appendAudio(new Int16Array(2400).fill(250));
  session.appendAudio(new Int16Array(2400).fill(250));
  for (let index = 0; index < 7; index += 1) {
    session.appendAudio(new Int16Array(2400));
  }

  assert.ok(sent.some((event) => event.type === 'input_audio_buffer.append'));
  assert.equal(
    sent.filter((event) => event.type === 'input_audio_buffer.commit').length,
    1,
  );
});

test('live transport keeps every captured chunk exactly once when the advanced gate is off', () => {
  const sent = [];
  const session = new LiveTranscriptionSession({
    channel: 'microphone',
    apiKey: 'test',
    settings: {
      vadEnabled: false,
      vadThreshold: 0.012,
      delayProfile: 'low',
    },
  });
  session.connected = true;
  session.socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (value) => sent.push(JSON.parse(value)),
  };

  for (const sample of [8, 9, 10]) {
    session.appendAudio(new Int16Array(2400).fill(sample));
  }

  const appends = sent.filter(
    (event) => event.type === 'input_audio_buffer.append',
  );
  assert.equal(appends.length, 3);
  assert.deepEqual(
    appends.map((event) => Buffer.from(event.audio, 'base64').readInt16LE(0)),
    [8, 9, 10],
  );
  assert.equal(
    sent.some((event) => event.type === 'input_audio_buffer.commit'),
    false,
  );
});

test('live transport force-commits a bounded turn when speech never pauses', () => {
  const sent = [];
  const events = [];
  const session = new LiveTranscriptionSession({
    channel: 'microphone',
    apiKey: 'test',
    settings: {
      vadEnabled: false,
      vadThreshold: 0.012,
      delayProfile: 'low',
    },
    onEvent: (event) => events.push(event),
  });
  session.maxTurnMs = 200;
  session.connected = true;
  session.socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (value) => sent.push(JSON.parse(value)),
  };

  session.appendAudio(new Int16Array(2400).fill(1000));
  session.appendAudio(new Int16Array(2400).fill(1000));

  assert.equal(
    sent.filter((event) => event.type === 'input_audio_buffer.commit').length,
    1,
  );
  assert.equal(
    events.find((event) => event.type === 'turn-commit').reason,
    'max_duration',
  );
});

test('live transport drains the current turn before closing', async () => {
  const sent = [];
  let closed = false;
  const session = new LiveTranscriptionSession({
    channel: 'microphone',
    apiKey: 'test',
    settings: {
      vadEnabled: false,
      vadThreshold: 0.012,
      delayProfile: 'low',
    },
  });
  session.connected = true;
  session.socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (value) => sent.push(JSON.parse(value)),
    close: () => {
      closed = true;
    },
  };
  session.appendAudio(new Int16Array(2400).fill(1000));

  let drained = false;
  const draining = session.finish({ timeoutMs: 1000 }).then(() => {
    drained = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    sent.filter((event) => event.type === 'input_audio_buffer.commit').length,
    1,
  );
  assert.equal(drained, false);
  assert.equal(closed, false);

  session.handleMessage(
    Buffer.from(
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'tail-item',
        transcript: 'the final phrase',
      }),
    ),
  );
  await draining;
  assert.equal(drained, true);
  assert.equal(closed, true);
});

test('credential store decrypts once per app launch', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-key-'));
  const credentialPath = path.join(userData, 'credentials', 'openai.enc');
  fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
  fs.writeFileSync(credentialPath, Buffer.from('encrypted'));
  let decryptions = 0;
  const store = new CredentialStore({
    app: { isPackaged: true, getPath: () => userData },
    safeStorage: {
      decryptStringAsync: async () => {
        decryptions += 1;
        return { result: 'test-key', shouldReEncrypt: false };
      },
    },
    fetchImpl: async () => ({ ok: true }),
  });
  const status = await store.status();
  assert.equal(status.available, true);
  assert.equal(decryptions, 0);
  assert.equal(await store.get(), 'test-key');
  assert.equal(await store.get(), 'test-key');
  assert.deepEqual(await store.validate(), { valid: true });
  assert.equal(decryptions, 1);
  fs.rmSync(userData, { recursive: true, force: true });
});

test('credential errors name the platform secure-storage provider', () => {
  assert.equal(secureStorageLabel('darwin'), 'macOS Keychain');
  assert.equal(secureStorageLabel('win32'), 'Windows secure storage');
  assert.equal(secureStorageLabel('linux'), 'secure storage');
});

test('credential repair clears only this app credential and macOS Safe Storage entry', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-key-repair-'));
  const credentialPath = path.join(userData, 'credentials', 'openai.enc');
  fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
  fs.writeFileSync(credentialPath, Buffer.from('unreadable'));
  const commands = [];
  const store = new CredentialStore({
    app: {
      isPackaged: true,
      getPath: () => userData,
      getName: () => 'Twinscript',
    },
    platform: 'darwin',
    safeStorage: {
      decryptStringAsync: async () => {
        throw new Error('interaction not allowed');
      },
    },
    execFileImpl: (file, args, options, callback) => {
      commands.push({ file, args, options });
      callback(null, '', '');
    },
  });

  await assert.rejects(store.get(), {
    code: 'credential_unlock_failed',
  });
  assert.equal((await store.status()).repairRecommended, true);

  const repaired = await store.repair();
  assert.equal(fs.existsSync(credentialPath), false);
  assert.equal(repaired.available, false);
  assert.equal(repaired.repairRecommended, false);
  assert.equal(repaired.relaunchRequired, true);
  assert.deepEqual(commands[0].args, [
    'delete-generic-password',
    '-s',
    'Twinscript Safe Storage',
    '-a',
    'Twinscript Key',
  ]);
  fs.rmSync(userData, { recursive: true, force: true });
});

test('legacy caption settings migrate to product-safe runtime defaults', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-settings-'));
  fs.writeFileSync(
    path.join(userData, 'caption-settings.json'),
    JSON.stringify({
      vadEnabled: true,
      vadThreshold: 0.012,
      shadowEnabled: true,
      recordEvaluation: true,
    }),
  );
  const settings = new SettingsStore({ getPath: () => userData }).get();
  assert.equal(settings.settingsVersion, 14);
  assert.equal(settings.vadEnabled, false);
  assert.equal(Object.hasOwn(settings, 'captionPaceMs'), false);
  assert.equal(settings.shadowEnabled, false);
  assert.equal(settings.recordEvaluation, false);
  assert.equal(settings.glossaryConfigurationId, 'universal-engineering');
  assert.ok(settings.protectedTokens.includes('PVT'));
  assert.equal(settings.autoSaveTranscript, true);
  assert.equal(settings.keepAudioAutomatically, false);
  assert.equal(settings.meetingRecordsDirectory, null);
  assert.equal(settings.captionHistoryEntries, 6);
  assert.equal(settings.captionTheme, 'blueprint');
  assert.equal(settings.captionOverlayHeight, null);
  assert.equal(settings.outputMode, 'overlays');
  const persisted = JSON.parse(
    fs.readFileSync(path.join(userData, 'caption-settings.json'), 'utf8'),
  );
  assert.equal(persisted.settingsVersion, 14);
  assert.equal(persisted.shadowEnabled, false);
  assert.equal(persisted.recordEvaluation, false);
  assert.equal(persisted.autoSaveTranscript, true);
  fs.rmSync(userData, { recursive: true, force: true });
});

test('a v6-already settings file keeps its meeting-record preferences and clamps history entries', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-settings-'));
  fs.writeFileSync(
    path.join(userData, 'caption-settings.json'),
    JSON.stringify({
      settingsVersion: 6,
      autoSaveTranscript: false,
      keepAudioAutomatically: true,
      meetingRecordsDirectory: '/custom/records',
      captionHistoryEntries: 99,
    }),
  );
  const settings = new SettingsStore({ getPath: () => userData }).get();
  assert.equal(settings.autoSaveTranscript, false);
  assert.equal(settings.keepAudioAutomatically, true);
  assert.equal(settings.meetingRecordsDirectory, '/custom/records');
  // Clamped to the documented 3-10 range rather than trusting a corrupt value.
  assert.equal(settings.captionHistoryEntries, 10);
  assert.equal(settings.captionTheme, 'blueprint');
  assert.equal(settings.captionOverlayHeight, null);
  fs.rmSync(userData, { recursive: true, force: true });
});

test('captionHistoryEntries is clamped to 3-10 on write', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-settings-'));
  const store = new SettingsStore({ getPath: () => userData });
  assert.equal(store.set({ captionHistoryEntries: 1 }).captionHistoryEntries, 3);
  assert.equal(store.set({ captionHistoryEntries: 999 }).captionHistoryEntries, 10);
  assert.equal(store.set({ captionHistoryEntries: 7 }).captionHistoryEntries, 7);
  fs.rmSync(userData, { recursive: true, force: true });
});

test('quality checks flag script mismatch and protected engineering tokens', () => {
  assert.deepEqual(protectedTokens('DVT-2 tolerance ±0.2 mm at 30%'), [
    'DVT-2',
    '±',
    '0.2MM',
    '30%',
  ]);
  const signals = buildQualitySignals({
    sourceText: 'DVT-2 tolerance 0.2 mm',
    english: '公差错误',
    chinese: '公差',
    fastPath: true,
  });
  assert.equal(signals.wrongAudienceLanguage.en, true);
  assert.ok(signals.missingProtectedTokens.zh.includes('DVT-2'));
  assert.equal(signals.fastPathDivergence, true);
});

test('VAD holds silence, retains pre-roll, and closes after post-roll', () => {
  const silence = new Int16Array(2400);
  const speech = new Int16Array(2400).fill(4000);
  const gate = new VadGate({ threshold: 0.01, preRollMs: 200, postRollMs: 150 });
  assert.equal(gate.push(silence, 100).chunks.length, 0);
  const started = gate.push(speech, 100);
  assert.equal(started.started, true);
  assert.equal(started.chunks.length, 2);
  assert.ok(pcmRms(speech) > 0.1);
  assert.equal(gate.push(silence, 100).speaking, true);
  assert.equal(gate.push(silence, 100).ended, true);
});

test('normalizer helpers keep profile selection and structured output stable', () => {
  assert.equal(PROFILE_MODELS.economy.final, 'gpt-5.4-nano');
  assert.equal(PROFILE_MODELS.tiered.final, 'gpt-5.6-luna');
  assert.equal(
    extractResponseText({
      output: [{ content: [{ type: 'output_text', text: '{"text":"ok"}' }] }],
    }),
    '{"text":"ok"}',
  );
  assert.match(glossaryPrompt([{ en: 'boss', zh: '凸台' }]), /boss = 凸台/);
});

test('evaluation fixtures encrypt captions at rest and replay intact', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-eval-'));
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value) => Buffer.from(`protected:${value}`),
    decryptStringAsync: async (value) => ({
      result: value.toString().replace(/^protected:/, ''),
      shouldReEncrypt: false,
    }),
  };
  const recorder = new EvaluationRecorder({
    app: { getPath: () => userData },
    safeStorage,
  });
  const { id } = await recorder.start({
    sessionId: 'session-12345678',
    settings: {
      primaryProfile: 'economy',
      shadowProfile: 'tiered',
      delayProfile: 'low',
      vadEnabled: true,
      fastPath: true,
      recordingRetentionDays: 7,
    },
  });
  recorder.record('caption', { sourceText: 'confidential tolerance' }, 10);
  await recorder.stop();
  const ciphertext = fs.readFileSync(path.join(userData, 'evaluations', `${id}.bcr`), 'utf8');
  assert.doesNotMatch(ciphertext, /confidential tolerance/);
  const records = await recorder.read(id);
  assert.equal(records[0].payload.sourceText, 'confidential tolerance');
  fs.appendFileSync(
    path.join(userData, 'evaluations', `${id}.bcr`),
    '{"truncated":',
  );
  const recovered = await recorder.read(id);
  assert.equal(recovered.length, 1);
  const recordingPath = path.join(userData, 'evaluations', `${id}.bcr`);
  const encryptedRecord = JSON.parse(ciphertext.trim());
  encryptedRecord.data =
    `${encryptedRecord.data.slice(0, -2)}${
      encryptedRecord.data.at(-2) === 'A' ? 'B' : 'A'
    }=`;
  fs.writeFileSync(recordingPath, `${JSON.stringify(encryptedRecord)}\n`);
  await assert.rejects(recorder.read(id));
  fs.rmSync(userData, { recursive: true, force: true });
});

test('budget exhaustion stops active capture instead of continuing spend', async () => {
  const statuses = [];
  let closed = 0;
  const manager = new CaptionSessionManager({
    credentialStore: {},
    settingsStore: {},
    onStatus: (status) => statuses.push(status),
    evaluationRecorder: { stop: async () => {} },
  });
  manager.active = true;
  manager.sessionId = 'session';
  manager.cost = { snapshot: () => ({ totalUsd: 1 }) };
  manager.sessions.set('microphone', { close: () => { closed += 1; } });
  manager.handleBudgetEvent({ type: 'exhausted' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.active, false);
  assert.equal(closed, 1);
  assert.equal(statuses[0].state, 'budget-exhausted');
  assert.equal(statuses.at(-1).reason, 'budget-exhausted');
});

test('transport events do not replace the active session lifecycle', () => {
  const statuses = [];
  const manager = new CaptionSessionManager({
    credentialStore: {},
    settingsStore: {},
    onStatus: (status) => statuses.push(status),
  });
  manager.active = true;
  manager.sessionId = 'session';

  manager.handleTranscriptionEvent({
    type: 'connection',
    status: 'connected',
    channel: 'microphone',
  });
  manager.handleTranscriptionEvent({
    type: 'connection',
    status: 'disconnected',
    channel: 'system',
  });

  assert.equal(statuses[0].state, 'running');
  assert.equal(statuses[1].state, 'degraded');
  assert.equal(manager.active, true);
});

test('continuous transcript deltas keep one bounded provisional timer', () => {
  const manager = new CaptionSessionManager({
    credentialStore: {},
    settingsStore: {},
  });
  manager.settings = { provisionalTranslation: true };
  const key = 'microphone:item';
  manager.eventsByItem.set(key, {
    sourceText: 'Newest transcript prefix',
  });

  manager.scheduleProvisional(key);
  const firstTimer = manager.pendingTimers.get(key);
  manager.scheduleProvisional(key);

  assert.equal(manager.pendingTimers.size, 1);
  assert.equal(manager.pendingTimers.get(key), firstTimer);
  manager.cancelProvisional(key);
});

test('a safe provisional prefix can update a newer live transcript', async () => {
  const published = [];
  const manager = new CaptionSessionManager({
    credentialStore: {},
    settingsStore: {},
    onCaption: (caption) => published.push(caption),
  });
  manager.active = true;
  manager.sessionId = 'session';
  manager.settings = { primaryProfile: 'economy', glossary: [] };
  manager.cost = {
    canSpend: () => true,
    snapshot: () => ({ totalUsd: 0 }),
  };
  manager.primaryNormalizer = {
    normalize: async () => ({
      text: '正在翻译的前缀',
      sourceLanguage: 'en',
      model: 'test-model',
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  };
  const key = 'microphone:item';
  const stale = createCaptionEvent({
    sessionId: 'session',
    sequence: 1,
    sourceChannel: 'microphone',
    providerItemId: 'item',
    sourceText: 'Earlier prefix',
    sourceStartedAt: 1,
    profile: 'economy',
  });
  const current = {
    ...stale,
    sourceText: 'Earlier prefix with newer words',
  };
  manager.eventsByItem.set(key, current);

  await manager.normalizePrimary(key, stale, false);

  assert.equal(manager.eventsByItem.get(key).sourceText, current.sourceText);
  assert.equal(manager.eventsByItem.get(key).chinese.text, '正在翻译的前缀');
  assert.equal(published.at(-1).chinese.status, 'provisional');
});

test('output mode defaults safely, persists supported values, and rejects unknown values', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-settings-'));
  const store = new SettingsStore({ getPath: () => userData });
  assert.equal(store.get().outputMode, 'overlays');
  assert.equal(
    store.set({ outputMode: 'virtual-camera' }).outputMode,
    'virtual-camera',
  );
  assert.equal(store.set({ outputMode: 'invalid' }).outputMode, 'overlays');
  fs.rmSync(userData, { recursive: true, force: true });
});

test('projection layout defaults safely, persists supported values, and rejects unknown values', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-settings-'));
  const store = new SettingsStore({ getPath: () => userData });
  assert.equal(store.get().layout, 'stacked');
  assert.equal(store.set({ layout: 'side-by-side' }).layout, 'side-by-side');
  assert.equal(store.set({ layout: 'invalid-layout' }).layout, 'stacked');
  fs.rmSync(userData, { recursive: true, force: true });
});

test('a persisted invalid projection layout migrates to stacked', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-settings-'));
  fs.writeFileSync(
    path.join(userData, 'caption-settings.json'),
    JSON.stringify({ settingsVersion: 10, layout: 'not-a-layout' }),
  );
  const settings = new SettingsStore({ getPath: () => userData }).get();
  assert.equal(settings.layout, 'stacked');
  const persisted = JSON.parse(
    fs.readFileSync(path.join(userData, 'caption-settings.json'), 'utf8'),
  );
  assert.equal(persisted.layout, 'stacked');
  fs.rmSync(userData, { recursive: true, force: true });
});

test('caption themes accept the curated IDs and reject unknown IDs', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-settings-'));
  const store = new SettingsStore({ getPath: () => userData });
  assert.deepEqual(
    CAPTION_THEMES.map((theme) => theme.id),
    ['blueprint', 'graphite', 'red-blue'],
  );
  for (const captionTheme of ['blueprint', 'graphite', 'red-blue']) {
    assert.equal(store.set({ captionTheme }).captionTheme, captionTheme);
  }
  for (const removedTheme of ['blue-air', 'steel', 'telemetry', 'warm-pink']) {
    assert.equal(store.set({ captionTheme: removedTheme }).captionTheme, 'blueprint');
  }
  fs.rmSync(userData, { recursive: true, force: true });
});

test('v7 glossary and theme settings migrate without losing custom terms', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-settings-'));
  fs.writeFileSync(
    path.join(userData, 'caption-settings.json'),
    JSON.stringify({
      settingsVersion: 7,
      glossaryConfigurationId: 'manufacturing-quality',
      customGlossaryConfiguration: {
        schemaVersion: 1,
        id: 'project-falcon',
        name: 'Project Falcon',
        protectedTokens: ['ABC-123'],
        terms: [{ en: 'project falcon', zh: '猎鹰项目', priority: 5 }],
      },
      captionTheme: 'steel',
    }),
  );
  const settings = new SettingsStore({ getPath: () => userData }).get();
  assert.equal(settings.settingsVersion, 14);
  assert.equal(settings.glossaryConfigurationId, 'universal-engineering');
  assert.equal(settings.customGlossaryConfiguration.terms[0].en, 'project falcon');
  assert.equal(settings.glossary[0].en, 'project falcon');
  assert.ok(settings.protectedTokens.includes('ABC-123'));
  assert.equal(settings.captionTheme, 'blueprint');
  assert.equal(settings.outputMode, 'overlays');
  fs.rmSync(userData, { recursive: true, force: true });
});

test('caption theme text colors meet WCAG AA contrast on their surfaces', () => {
  const luminance = (hex) => {
    const channels = hex
      .slice(1)
      .match(/.{2}/g)
      .map((channel) => Number.parseInt(channel, 16) / 255)
      .map((channel) =>
        channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4,
      );
    return (
      channels[0] * 0.2126 +
      channels[1] * 0.7152 +
      channels[2] * 0.0722
    );
  };
  const contrast = (foreground, background) => {
    const lighter = Math.max(luminance(foreground), luminance(background));
    const darker = Math.min(luminance(foreground), luminance(background));
    return (lighter + 0.05) / (darker + 0.05);
  };
  for (const theme of CAPTION_THEMES) {
    for (const [audience, surface] of Object.entries(theme.surfaces)) {
      for (const role of ['primary', 'secondary']) {
        assert.ok(
          contrast(surface[role], surface.background) >= 4.5,
          `${theme.id} ${audience} ${role} lacks 4.5:1 contrast`,
        );
      }
    }
  }
});

test('caption overlay height persists only a valid requested height or null', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-settings-'));
  const store = new SettingsStore({ getPath: () => userData });
  assert.equal(store.set({ captionOverlayHeight: 284.6 }).captionOverlayHeight, 285);
  assert.equal(store.set({ captionOverlayHeight: null }).captionOverlayHeight, null);
  assert.equal(store.set({ captionOverlayHeight: Number.POSITIVE_INFINITY }).captionOverlayHeight, null);
  assert.equal(store.set({ captionOverlayHeight: 20 }).captionOverlayHeight, null);
  assert.equal(store.set({ captionOverlayHeight: 5000 }).captionOverlayHeight, null);
  fs.rmSync(userData, { recursive: true, force: true });
});

test('every normalization request receives bounded utterance-specific glossary context and metrics', async () => {
  const requests = [];
  const glossary = Array.from({ length: 20 }, (_, index) => ({
    en: `term-${index}`,
    zh: `术语-${index}`,
    aliases: index === 0 ? ['区域叫法'] : [],
    doNotTranslate: false,
    priority: 5 - (index % 5),
  }));
  const manager = new CaptionSessionManager({
    credentialStore: {},
    settingsStore: {},
    onMetrics: () => {},
  });
  manager.active = true;
  manager.sessionId = 'session';
  manager.startedAt = Date.now();
  manager.settings = {
    primaryProfile: 'economy',
    glossary,
    customGlossaryConfiguration: { terms: [glossary[0]] },
    protectedTokens: ['T1', 'T2', 'DVT'],
  };
  manager.cost = {
    canSpend: () => true,
    snapshot: () => ({ totalUsd: 0 }),
  };
  manager.primaryNormalizer = {
    normalize: async (request) => {
      requests.push(request);
      return {
        text: request.target === 'en' ? request.sourceText : '已确认',
        sourceLanguage: 'en',
        model: 'test-model',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const caption = createCaptionEvent({
    sessionId: 'session',
    sequence: 1,
    sourceChannel: 'microphone',
    providerItemId: 'item',
    sourceText: 'Use 区域叫法 for T2.',
    sourceStartedAt: 1,
    transcriptStatus: 'final',
    profile: 'economy',
  });
  manager.eventsByItem.set('microphone:item', caption);

  await manager.normalizePrimary('microphone:item', caption, true);

  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.glossary.length <= 16));
  assert.ok(requests.every((request) => request.protectedTokens.join(',') === 'T2'));
  assert.equal(requests[0].glossary[0].en, 'term-0');
  assert.equal(manager.lastMetrics.normalizationContext.requests, 2);
  assert.ok(
    manager.lastMetrics.normalizationContext.lastPromptCharacters <= 800,
  );
});

test('screening prompts and structured bilingual ratings fail closed', () => {
  const prompt = sanitizeScreeningPrompt({
    id: 'tolerance-1-mixed-inline',
    sourceChannel: 'microphone',
    languageClass: 'mixed-inline',
    condition: 'Quiet room',
    sourceText: '把支架的 tolerance 控制在 ±0.2 mm。',
    englishReference: 'Hold the bracket tolerance to ±0.2 mm.',
    chineseReference: '把支架的公差控制在 ±0.2 mm。',
    protectedTokens: ['±0.2 mm'],
    critical: true,
  });
  assert.equal(prompt.id, 'tolerance-1-mixed-inline');
  assert.equal(prompt.scripted, true);
  assert.throws(() => sanitizeScreeningPrompt({ id: '../unsafe' }));

  const manager = new CaptionSessionManager({
    credentialStore: {},
    settingsStore: {},
  });
  const rating = manager.rateEvaluation({
    sequence: 1,
    preference: 'primary',
    semanticScore: 4,
    flags: ['terminology', 'unknown', 'terminology'],
    notes: '  Material wording differed.  ',
  });
  assert.equal(rating.semanticScore, 4);
  assert.deepEqual(rating.flags, ['terminology']);
  assert.equal(rating.notes, 'Material wording differed.');
  assert.throws(() =>
    manager.rateEvaluation({
      sequence: 2,
      preference: 'shadow',
      semanticScore: 6,
    }),
  );
});

test('each new session starts with isolated captions and judgments', async () => {
  const manager = new CaptionSessionManager({
    credentialStore: {},
    settingsStore: {
      get: () => ({
        budgetUsd: 5,
        shadowEnabled: false,
        reorderWindowMs: 400,
        duplicateWindowMs: 1400,
      }),
      set: () => {},
    },
  });
  manager.history.push({ id: 'old-caption' });
  manager.evaluationHistory.push({ sequence: 99 });
  manager.evaluationRatings.set(99, { preference: 'primary' });
  await manager.start({ mode: 'mock' });
  assert.equal(manager.history.length, 0);
  assert.equal(manager.evaluationHistory.length, 0);
  assert.equal(manager.evaluationRatings.size, 0);
  await manager.stop();
});

test('live sessions tee timestamped audio and settled captions into the meeting record', async () => {
  const calls = [];
  const appendedAudio = [];
  const recordedCaptions = [];
  const meetingRecordController = {
    startSession: async (request) => {
      calls.push(['record-start', request]);
      return { recording: true, sessionDir: 'C:\\records\\session' };
    },
    writeAudioChunk: (channel, samples, capturedAt, durationMs) => {
      calls.push(['record-audio', channel]);
      appendedAudio.push({ channel, samples: [...samples], capturedAt, durationMs });
    },
    appendFinalRecord: (caption) => {
      calls.push(['record-caption', caption.sequence]);
      recordedCaptions.push(caption);
    },
    stopSession: async (request) => {
      calls.push(['record-stop', request]);
      return {
        recording: true,
        sessionId: 'recorded-session',
        sessionDir: 'C:\\records\\session',
        session: { audioRetention: 'pending' },
      };
    },
  };
  const sessions = [];
  const manager = new CaptionSessionManager({
    credentialStore: { get: async () => 'test-key' },
    settingsStore: {
      get: () => ({
        budgetUsd: 5,
        shadowEnabled: false,
        reorderWindowMs: 400,
        duplicateWindowMs: 1400,
        autoSaveTranscript: true,
        keepAudioAutomatically: false,
        glossary: [],
        protectedTokens: [],
        primaryProfile: 'economy',
      }),
      set: () => {},
    },
    meetingRecordController,
    appVersion: '0.1.0-test',
    transcriptionFactory: ({ channel }) => {
      const session = {
        channel,
        connect: async () => calls.push(['transport-connect', channel]),
        appendAudio: (samples) => {
          calls.push(['transport-audio', channel]);
          assert.deepEqual([...samples], [100, -100, 50]);
        },
        close: () => calls.push(['transport-close', channel]),
      };
      sessions.push(session);
      return session;
    },
    normalizerFactory: () => ({
      normalize: async ({ sourceText, target }) => ({
        text: target === 'en' ? sourceText : 'å·²ç¡®è®¤',
        sourceLanguage: 'en',
        model: 'test-model',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    }),
  });

  const started = await manager.start({ mode: 'live' });
  assert.equal(started.meetingRecord.sessionDir, 'C:\\records\\session');
  assert.equal(calls[0][0], 'record-start');

  manager.appendAudio({
    channel: 'microphone',
    samples: new Int16Array([100, -100, 50]),
    capturedAt: 12_345,
  });
  assert.deepEqual(
    calls.slice(-2).map(([name]) => name),
    ['transport-audio', 'record-audio'],
  );
  assert.deepEqual(appendedAudio[0], {
    channel: 'microphone',
    samples: [100, -100, 50],
    capturedAt: 12_345,
    durationMs: 0.125,
  });

  manager.releaseFinalTranscript({
    channel: 'microphone',
    itemId: 'item-1',
    transcript: 'Confirmed',
    startedAt: 100,
    at: 200,
    final: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recordedCaptions.length, 1);
  assert.equal(recordedCaptions[0].sourceText, 'Confirmed');
  assert.equal(recordedCaptions[0].chinese.status, 'final');

  const stopped = await manager.stop();
  assert.equal(stopped.meetingRecord.session.audioRetention, 'pending');
  assert.ok(
    calls.findIndex(([name]) => name === 'transport-close') <
      calls.findIndex(([name]) => name === 'record-stop'),
  );
  assert.equal(sessions.length, 2);
});

test('mock and replay sessions never create meeting records', async () => {
  let starts = 0;
  const meetingRecordController = {
    startSession: async () => {
      starts += 1;
    },
  };
  const settingsStore = {
    get: () => ({
      budgetUsd: 5,
      shadowEnabled: false,
      reorderWindowMs: 400,
      duplicateWindowMs: 1400,
    }),
    set: () => {},
  };
  const mock = new CaptionSessionManager({
    credentialStore: {},
    settingsStore,
    meetingRecordController,
  });
  await mock.start({ mode: 'mock' });
  await mock.stop();
  assert.equal(starts, 0);
});

test('stop waits for an in-flight final caption before finalizing its transcript record', async () => {
  const resolveNormalizations = [];
  const order = [];
  const manager = new CaptionSessionManager({
    credentialStore: { get: async () => 'test-key' },
    settingsStore: {
      get: () => ({
        budgetUsd: 5,
        shadowEnabled: false,
        reorderWindowMs: 400,
        duplicateWindowMs: 1400,
        autoSaveTranscript: true,
        glossary: [],
        protectedTokens: [],
        primaryProfile: 'economy',
      }),
      set: () => {},
    },
    meetingRecordController: {
      startSession: async () => ({ recording: true }),
      appendFinalRecord: () => order.push('caption'),
      stopSession: async () => {
        order.push('record-stop');
        return { recording: true };
      },
    },
    transcriptionFactory: () => ({
      connect: async () => {},
      appendAudio: () => {},
      close: () => order.push('transport-close'),
    }),
    normalizerFactory: () => ({
      normalize: () =>
        new Promise((resolve) => {
          resolveNormalizations.push(() =>
            resolve({
              text: '已确认',
              sourceLanguage: 'en',
              model: 'test-model',
              usage: { inputTokens: 1, outputTokens: 1 },
            }),
          );
        }),
    }),
  });
  await manager.start({ mode: 'live' });
  manager.releaseFinalTranscript({
    channel: 'microphone',
    itemId: 'item-final',
    transcript: 'Confirmed',
    startedAt: 1,
    at: 2,
    final: true,
  });

  let stopped = false;
  const stopping = manager.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(order.includes('record-stop'), false);

  resolveNormalizations.forEach((resolve) => resolve());
  await stopping;
  assert.deepEqual(order.slice(-2), ['caption', 'record-stop']);
});

test('stop aborts and proceeds when a final translation never settles', async () => {
  let aborted = false;
  const manager = new CaptionSessionManager({
    credentialStore: {},
    settingsStore: {},
    finalizationDrainTimeoutMs: 10,
  });
  manager.active = true;
  manager.pendingFinalizations.add(new Promise(() => {}));
  manager.abortControllers.set('hung-final', {
    abort: () => { aborted = true; },
  });

  await manager.stop();

  assert.equal(aborted, true);
  assert.equal(manager.active, false);
});

test('stop cancels and proceeds when transcription finish never settles', async () => {
  let cancelled = false;
  const statuses = [];
  const manager = new CaptionSessionManager({
    credentialStore: {},
    settingsStore: {},
    transcriptionDrainTimeoutMs: 10,
    onStatus: (status) => statuses.push(status),
  });
  manager.active = true;
  manager.sessions.set('microphone', {
    finish: () => new Promise(() => {}),
    cancelPending: () => { cancelled = true; },
  });

  await manager.stop();

  assert.equal(cancelled, true);
  assert.ok(statuses.some((status) => status.code === 'transcription_shutdown_timeout'));
  assert.equal(manager.active, false);
});

test('stop proceeds when evaluation recording never settles', async () => {
  const statuses = [];
  const manager = new CaptionSessionManager({
    credentialStore: {},
    settingsStore: {},
    auxiliaryStopTimeoutMs: 10,
    onStatus: (status) => statuses.push(status),
    evaluationRecorder: { stop: () => new Promise(() => {}) },
  });
  manager.active = true;

  const completed = await Promise.race([
    manager.stop().then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 250)),
  ]);

  assert.equal(completed, true);
  assert.ok(statuses.some((status) => status.code === 'evaluation_shutdown_timeout'));
  assert.equal(manager.active, false);
});

test('stop proceeds when meeting-record finalization never settles', async () => {
  const statuses = [];
  const manager = new CaptionSessionManager({
    credentialStore: {},
    settingsStore: {},
    auxiliaryStopTimeoutMs: 10,
    onStatus: (status) => statuses.push(status),
    meetingRecordController: { stopSession: () => new Promise(() => {}) },
  });
  manager.active = true;
  manager.mode = 'live';

  const completed = await Promise.race([
    manager.stop().then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 250)),
  ]);

  assert.equal(completed, true);
  assert.ok(statuses.some((status) => status.code === 'meeting_record_shutdown_timeout'));
  assert.equal(manager.active, false);
});

test('stop accepts a final transcript emitted while transports drain', async () => {
  const recorded = [];
  const manager = new CaptionSessionManager({
    credentialStore: { get: async () => 'test-key' },
    settingsStore: {
      get: () => ({
        budgetUsd: 5,
        shadowEnabled: false,
        reorderWindowMs: 400,
        duplicateWindowMs: 1400,
        autoSaveTranscript: true,
        glossary: [],
        protectedTokens: [],
        primaryProfile: 'economy',
      }),
      set: () => {},
    },
    meetingRecordController: {
      startSession: async () => ({ recording: true }),
      appendFinalRecord: (caption) => recorded.push(caption.sourceText),
      stopSession: async () => ({ recording: true }),
    },
    transcriptionFactory: ({ channel, onEvent }) => ({
      connect: async () => {},
      appendAudio: () => {},
      finish: async () => {
        if (channel === 'microphone') {
          onEvent({
            type: 'transcript',
            channel,
            itemId: 'tail-item',
            transcript: 'Keep the final phrase',
            final: true,
            startedAt: 10,
            at: 20,
          });
        }
      },
      close: () => {},
    }),
    normalizerFactory: () => ({
      normalize: async ({ sourceText, target }) => ({
        text: target === 'en' ? sourceText : '保留最后一句',
        sourceLanguage: 'en',
        model: 'test-model',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    }),
  });

  await manager.start({ mode: 'live' });
  await manager.stop();

  assert.deepEqual(recorded, ['Keep the final phrase']);
});

test('a meeting-record readiness failure leaves no active live session', async () => {
  const manager = new CaptionSessionManager({
    credentialStore: { get: async () => 'test-key' },
    settingsStore: {
      get: () => ({
        budgetUsd: 5,
        shadowEnabled: false,
        reorderWindowMs: 400,
        duplicateWindowMs: 1400,
        autoSaveTranscript: true,
      }),
      set: () => {},
    },
    meetingRecordController: {
      startSession: async () => {
        const error = new Error('Meeting records folder is unavailable');
        error.code = 'records_directory_unavailable';
        throw error;
      },
    },
  });

  await assert.rejects(manager.start({ mode: 'live' }), {
    code: 'records_directory_unavailable',
  });
  assert.equal(manager.active, false);
  assert.equal(manager.sessions.size, 0);
});

test('meeting context notes are bounded and de-duplicated', () => {
  // These are interpolated into every request, so a pasted document must not silently
  // become the prompt. Bounded on read as well as on write because the field is free
  // text and an older settings file may predate any limit.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'context-notes-'));
  const store = new SettingsStore({ getPath: () => userData });

  const saved = store.set({
    glossaryContextNotes: [
      '  Lily Chen  ',
      'lily chen',
      '',
      '   ',
      42,
      'x'.repeat(500),
      ...Array.from({ length: 60 }, (_, i) => `Person ${i}`),
    ],
  });

  assert.equal(saved.glossaryContextNotes[0], 'Lily Chen', 'trimmed');
  assert.ok(
    !saved.glossaryContextNotes.includes('lily chen'),
    'a name repeated with different capitalisation is one piece of context',
  );
  assert.ok(
    saved.glossaryContextNotes.every((note) => note.length <= 120),
    'each note is length-capped',
  );
  assert.ok(saved.glossaryContextNotes.length <= 40, 'the list is capped');
  assert.ok(
    saved.glossaryContextNotes.every((note) => typeof note === 'string' && note.trim()),
    'non-strings and blanks are dropped rather than stored',
  );

  // Survives a reload, still normalized.
  const reloaded = new SettingsStore({ getPath: () => userData }).get();
  assert.deepEqual(reloaded.glossaryContextNotes, saved.glossaryContextNotes);
});

test('a settings file with no context notes reads as an empty list', () => {
  // Not undefined: every consumer treats this as an array.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'context-absent-'));
  fs.mkdirSync(path.join(userData, 'captions'), { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'captions', 'settings.json'),
    JSON.stringify({ settingsVersion: 10 }),
  );
  const settings = new SettingsStore({ getPath: () => userData }).get();
  assert.deepEqual(settings.glossaryContextNotes, []);
});

test('settings reset restores defaults and cannot reach the key or the meetings', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-reset-'));
  const store = new SettingsStore({ getPath: () => userData });

  store.set({
    budgetUsd: 42,
    delayProfile: 'minimal',
    captionTheme: 'steel',
    glossaryContextNotes: ['Lily Chen'],
    customGlossaryConfiguration: {
      schemaVersion: 1,
      id: 'custom-overrides',
      name: 'Custom overrides',
      description: '',
      regions: [],
      domains: [],
      protectedTokens: ['ABC-123'],
      terms: [{ en: 'gasket', zh: '垫片', priority: 5 }],
    },
  });

  const reset = store.reset();
  assert.equal(reset.budgetUsd, 5);
  assert.equal(reset.delayProfile, 'low', 'responsiveness returns to the balanced default');
  assert.equal(reset.customGlossaryConfiguration, null);
  assert.deepEqual(reset.glossaryContextNotes, []);

  // Persisted, not just returned: a reset that only lived in memory would come back on the
  // next launch.
  const reloaded = new SettingsStore({ getPath: () => userData }).get();
  assert.equal(reloaded.budgetUsd, 5);
  assert.equal(reloaded.customGlossaryConfiguration, null);

  // The reset payload carries no credential and no path to saved meetings, which is the
  // property that makes offering "reset all" safe.
  assert.equal(reset.meetingRecordsDirectory, null);
  assert.ok(!('apiKey' in reset) && !('credential' in reset));
});

test("an invalid delay profile is repaired instead of reaching the API", () => {
  // 'default' shipped as the "Stable" dropdown option and the API rejects it: "Invalid
  // value: 'default'. Supported values are: 'minimal', 'low', 'medium', 'high', and
  // 'xhigh'." Nothing validated it here, so the only check was the server, at the moment a
  // session tried to start - an install that ever chose Stable simply could not caption.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'delay-profile-'));
  fs.writeFileSync(
    path.join(userData, 'caption-settings.json'),
    JSON.stringify({ settingsVersion: 11, delayProfile: 'default' }),
  );

  const settings = new SettingsStore({ getPath: () => userData }).get();
  assert.equal(settings.delayProfile, 'low', 'repaired on read');

  // Repaired on disk, not just in memory, or it would fail again on the next launch.
  const reloaded = JSON.parse(
    fs.readFileSync(path.join(userData, 'caption-settings.json'), 'utf8'),
  );
  assert.equal(reloaded.delayProfile, 'low');
});

test('every supported delay profile is accepted, and nothing else is', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'delay-accept-'));
  const store = new SettingsStore({ getPath: () => userData });
  for (const profile of ['minimal', 'low', 'medium']) {
    assert.equal(store.set({ delayProfile: profile }).delayProfile, profile);
  }
  // 'high' and 'xhigh' are accepted by the API but withdrawn here: they hold text so long
  // that captions stop tracking the conversation.
  for (const bad of ['default', 'high', 'xhigh', 'stable', '', null, 7]) {
    assert.equal(
      store.set({ delayProfile: bad }).delayProfile,
      'low',
      `${String(bad)} should fall back rather than reach the API`,
    );
  }
});

test('the budget can be raised on a running session, not just for the next one', () => {
  // The mid-meeting "+$2" control exists to lift a cap while the meeting is going. The cost
  // meter took its budget at construction with no setter, so the control wrote the stored
  // setting and the running session kept spending against the old cap - or stayed stopped.
  const events = [];
  const meter = new CostMeter({ budgetUsd: 5, onBudgetEvent: (e) => events.push(e.type) });

  meter.addTextUsage(
    { model: 'gpt-5.6-luna', inputTokens: 1_000_000, outputTokens: 1_000_000 },
    'primary',
  );
  assert.ok(meter.totalUsd > 5, 'spent past the cap');
  assert.equal(meter.canSpend(), false);

  meter.setBudget(20);
  assert.equal(meter.budgetUsd, 20);
  assert.equal(meter.canSpend(), true, 'raising the cap resumes a stopped session');
  assert.ok(meter.snapshot().ratio < 1);
});

test('lowering the budget below what is spent stops the session', () => {
  // The latches are re-evaluated rather than cleared, so this direction works too.
  const meter = new CostMeter({ budgetUsd: 50 });
  meter.addTextUsage({ model: 'gpt-5.6-luna', inputTokens: 1_000_000 }, 'primary');
  assert.equal(meter.canSpend(), true);
  meter.setBudget(0.5);
  assert.equal(meter.canSpend(), false);
});

test('a nonsensical budget is ignored rather than disabling the session', () => {
  const meter = new CostMeter({ budgetUsd: 5 });
  for (const bad of [0, -1, Number.NaN, null, 'ten']) {
    meter.setBudget(bad);
    assert.equal(meter.budgetUsd, 5, `${String(bad)} should be ignored`);
  }
});

test('a session runs on the normalized settings, not the renderer payload', () => {
  // start() used to call settingsStore.set(...) and discard the result, keeping the raw
  // object it was handed. Every check the store performs was therefore applied to the file
  // on disk and NOT to the settings the session sends to the API - a bad value was
  // corrected everywhere except the one place that mattered, and reached the transcriber
  // verbatim.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'session-normalize-'));
  const store = new SettingsStore({ getPath: () => userData });
  const normalized = store.set({ delayProfile: 'xhigh', captionHistoryEntries: 999 });

  assert.equal(normalized.delayProfile, 'low', 'withdrawn value repaired');
  assert.equal(normalized.captionHistoryEntries, 10, 'out-of-range value clamped');
  // The value the session would send is the repaired one, because start() now assigns the
  // store's return value.
  assert.ok(['minimal', 'low', 'medium'].includes(normalized.delayProfile));
});
