const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyScript,
  createCaptionEvent,
  projectForAudience,
  updateTarget,
} = require('./caption-domain');
const { CostMeter } = require('./cost-meter');
const { extractResponseText, glossaryPrompt, PROFILE_MODELS } = require('./openai-normalizer');
const { pcmRms, VadGate } = require('./vad-gate');
const { EvaluationRecorder } = require('./evaluation-recorder');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  fs.rmSync(userData, { recursive: true, force: true });
});
