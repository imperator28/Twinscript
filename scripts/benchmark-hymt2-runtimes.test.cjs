const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BENCHMARK_CASES,
  MODEL_SHA256,
  summarizeBenchmark,
} = require('./benchmark-hymt2-runtimes.cjs');

const passingCaseResults = (actualDevice) => BENCHMARK_CASES.map((entry) => ({
  id: entry.id,
  actualDevice,
  text: `translated ${entry.protectedTokens.join(' ')}`,
}));

const samples = (inferenceMs, visibleMs) => Array.from({ length: 10 }, (_, repetition) =>
  BENCHMARK_CASES.map(({ id }) => ({
    caseId: id,
    repetition,
    inferenceMs: inferenceMs + repetition,
    visibleMs: visibleMs + repetition,
    requestMs: inferenceMs + repetition + 2,
  }))).flat();

const passingInput = () => ({
  revision: 'b9940',
  modelSha256: MODEL_SHA256,
  cpu: {
    actualDevice: 'CPU',
    cases: passingCaseResults('CPU'),
    samples: samples(100, 130),
  },
  cuda: {
    actualDevice: 'CUDA0',
    cases: passingCaseResults('CUDA0'),
    samples: samples(60, 90),
  },
});

test('passes only when six bilingual cases preserve literals and CUDA clears both latency gates', () => {
  const result = summarizeBenchmark(passingInput());

  assert.deepEqual(Object.keys(result), [
    'revision', 'modelSha256', 'cpu', 'cuda', 'medianImprovement', 'qualityPassed', 'passed',
  ]);
  assert.equal(result.revision, 'b9940');
  assert.equal(result.modelSha256, MODEL_SHA256);
  assert.equal(result.cpu.medianInferenceMs, 105);
  assert.equal(result.cpu.p95VisibleMs, 139);
  assert.equal(result.cuda.medianInferenceMs, 65);
  assert.equal(result.cuda.p95VisibleMs, 99);
  assert.ok(result.medianImprovement >= 0.3);
  assert.equal(result.qualityPassed, true);
  assert.equal(result.passed, true);
});

test('fails when CUDA evidence is not CUDA0 or a protected literal is lost', () => {
  const wrongDevice = passingInput();
  wrongDevice.cuda.actualDevice = 'CPU';
  assert.equal(summarizeBenchmark(wrongDevice).passed, false);

  const lostLiteral = passingInput();
  lostLiteral.cuda.cases[0].text = 'translated without the protected value';
  const result = summarizeBenchmark(lostLiteral);
  assert.equal(result.qualityPassed, false);
  assert.equal(result.passed, false);

  const midRunFallback = passingInput();
  midRunFallback.cuda.cases[0].actualDevice = 'CPU';
  assert.equal(summarizeBenchmark(midRunFallback).qualityPassed, false);
});

test('fails when improvement is below 30 percent or CUDA visible p95 regresses', () => {
  const slowMedian = passingInput();
  slowMedian.cuda.samples = samples(72, 90);
  assert.equal(summarizeBenchmark(slowMedian).passed, false);

  const slowVisible = passingInput();
  slowVisible.cuda.samples = samples(60, 140);
  assert.equal(summarizeBenchmark(slowVisible).passed, false);
});

test('rejects incomplete, mismatched, or unpinned evidence', () => {
  const incomplete = passingInput();
  incomplete.cpu.samples = incomplete.cpu.samples.filter(({ caseId }) => caseId !== BENCHMARK_CASES[0].id);
  assert.throws(() => summarizeBenchmark(incomplete), /ten measured samples/i);

  const missingCase = passingInput();
  missingCase.cuda.cases.pop();
  assert.throws(() => summarizeBenchmark(missingCase), /six benchmark cases/i);

  const wrongHash = passingInput();
  wrongHash.modelSha256 = '0'.repeat(64);
  assert.throws(() => summarizeBenchmark(wrongHash), /pinned HY-MT2 model/i);
});
