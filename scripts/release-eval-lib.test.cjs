const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EvaluationBudget, acousticScores, loadAudioManifest, geminiSetup, geminiTranscripts, missingLiterals } = require('./release-eval-lib.cjs');

test('evaluation budget requires an explicit finite limit and retains unknown-bill reservations', () => {
  for (const n of [undefined, NaN, Infinity, 0, -1, 6]) assert.throws(() => new EvaluationBudget(n));
  const budget = new EvaluationBudget(0.1);
  budget.reserve(0.06);
  assert.throws(() => budget.reserve(0.06), /budget_exhausted/);
  assert.equal(budget.reservedUsd, 0.06);
});
test('acoustic metrics retain numeric errors and mixed Chinese/English tokens', () => {
  assert.deepEqual(acousticScores('检查 EVT 3', '检查 EVT 3'), { cer: 0, mixedTokenErrorRate: 0 });
  assert.ok(acousticScores('检查 EVT 3', '检查 EVT 8').cer > 0);
  assert.deepEqual(missingLiterals('EVT DVT T1', 'EVT T1', ['EVT', 'DVT', 'T1']), ['DVT']);
});
test('Gemini ASR uses text-only dedicated model and distinguishes interim hypotheses from finalized transcripts', () => {
  const setup = geminiSetup().setup;
  assert.equal(setup.model, 'models/gemini-3.5-transcribe-live');
  assert.deepEqual(setup.generationConfig.responseModalities, ['TEXT']);
  assert.equal(setup.inputAudioTranscription.mode, 'VERBATIM');
  assert.deepEqual(geminiTranscripts({ serverContent: { interimInputTranscription: { text: '检查' }, inputTranscription: { text: '检查 EVT' } } }),
    [{ text: '检查', final: false }, { text: '检查 EVT', final: true }]);
  assert.throws(() => geminiTranscripts({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'audio' } }] } } }), /generated media/);
});
test('audio fixtures require consent, channel and exact bounded PCM sample provenance', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twinscript-eval-'));
  try {
    fs.writeFileSync(path.join(root, 'fixture.pcm'), Buffer.alloc(4800));
    const manifest = path.join(root, 'manifest.json');
    const fixture = { id: 'fixture', consented: true, sourceChannel: 'system', sampleRate: 24000,
      sampleStart: 0, sampleEnd: 2400, captureStartedAt: '2026-11-09T00:00:00Z', reference: '检查 EVT 3', pcmPath: 'fixture.pcm' };
    const load = overrides => { fs.writeFileSync(manifest, JSON.stringify({ fixtures: [{ ...fixture, ...overrides }] })); return loadAudioManifest(manifest); };
    assert.equal(load({})[0].durationMs, 100);
    for (const bad of [{ consented: false }, { sourceChannel: 'combined' }, { sampleEnd: 2401 }, { sampleRate: 16000 }, { sampleStart: -1 }]) assert.throws(() => load(bad));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('default translation evaluation plans without secrets or a network call', () => {
  const env = { ...process.env }; delete env.OPENAI_API_KEY; delete env.GEMINI_API_KEY;
  const result = spawnSync(process.execPath, ['scripts/eval-release-models.mjs', '--limit', '4'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.measured, false);
  assert.equal(plan.completed, 0);
  assert.ok(plan.plan.models.includes('gpt-6-luna'));
  const live = spawnSync(process.execPath, ['scripts/eval-release-models.mjs', '--live'], { encoding: 'utf8', env });
  assert.notEqual(live.status, 0);
});
