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
const { CredentialStore } = require('./credential-store');
const { LiveTranscriptionSession } = require('./live-transcription-session');
const { PriorityTaskQueue } = require('./priority-task-queue');
const { SettingsStore } = require('./settings-store');
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
  coordinator.submit({
    channel: 'microphone',
    itemId: 'later',
    transcript: 'Move DVT to September',
    startedAt: 200,
    at: 500,
  });
  coordinator.submit({
    channel: 'system',
    itemId: 'earlier',
    transcript: '确认模具时间',
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
  assert.equal(settings.settingsVersion, 4);
  assert.equal(settings.vadEnabled, false);
  assert.equal(settings.captionPaceMs, 1200);
  assert.equal(settings.shadowEnabled, false);
  assert.equal(settings.recordEvaluation, false);
  const persisted = JSON.parse(
    fs.readFileSync(path.join(userData, 'caption-settings.json'), 'utf8'),
  );
  assert.equal(persisted.settingsVersion, 4);
  assert.equal(persisted.shadowEnabled, false);
  assert.equal(persisted.recordEvaluation, false);
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
