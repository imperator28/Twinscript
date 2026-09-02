const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { CaptionSessionManager } = require('../electron/captions/caption-session-manager');
const {
  CPU_RUNTIME,
  CUDA_RUNTIME,
  LlamaTranslationServer,
} = require('../electron/captions/llama-translation-client');
const { LocalHyMt2Backend } = require('../electron/captions/translation-backends');

const MODEL_SHA256 = 'dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699';
const MIN_REPETITIONS = 10;

const BENCHMARK_CASES = Object.freeze([
  { id: 'en-voltage', sourceLanguage: 'English', targetLanguage: 'Chinese', text: 'Set the supply to 24 VDC.', protectedTokens: ['24 VDC'] },
  { id: 'zh-tolerance', sourceLanguage: 'Chinese', targetLanguage: 'English', text: '公差必须保持在 ±0.2 mm。', protectedTokens: ['±0.2 mm'] },
  { id: 'en-name-part', sourceLanguage: 'English', targetLanguage: 'Chinese', text: 'Alice approved fixture A-17 for production.', protectedTokens: ['Alice', 'A-17'] },
  { id: 'zh-name-time', sourceLanguage: 'Chinese', targetLanguage: 'English', text: '工程师 张伟，将在 3:30 检查样机。', protectedTokens: ['张伟', '3:30'] },
  { id: 'mixed-revision', sourceLanguage: 'English', targetLanguage: 'Chinese', text: '请 review the CAD file rev B before release.', protectedTokens: ['CAD', 'rev B'] },
  { id: 'mixed-token', sourceLanguage: 'Chinese', targetLanguage: 'English', text: 'Please 保留 API token ZX-42 不变。', protectedTokens: ['API', 'ZX-42'] },
]);

const percentile = (values, ratio) => {
  const sorted = values.map(Number).sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
};

const median = (values) => {
  const sorted = values.map(Number).sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

function assertEvidenceSide(side, expectedDevice) {
  if (!side || !Array.isArray(side.samples)) {
    throw new Error('Each runtime requires at least ten measured samples for every case.');
  }
  if (!Array.isArray(side.cases) || side.cases.length !== BENCHMARK_CASES.length) {
    throw new Error('Each runtime must report all six benchmark cases.');
  }
  const expectedIds = BENCHMARK_CASES.map(({ id }) => id).sort();
  const actualIds = side.cases.map(({ id }) => id).sort();
  if (actualIds.join('\0') !== expectedIds.join('\0')) {
    throw new Error('Runtime benchmark case identifiers do not match the six benchmark cases.');
  }
  for (const sample of side.samples) {
    if (!Number.isFinite(sample.inferenceMs) || sample.inferenceMs < 0 ||
        !Number.isFinite(sample.visibleMs) || sample.visibleMs < 0) {
      throw new Error('Runtime benchmark samples require finite non-negative latency.');
    }
  }
  for (const { id } of BENCHMARK_CASES) {
    if (side.samples.filter(({ caseId }) => caseId === id).length < MIN_REPETITIONS) {
      throw new Error('Each runtime requires at least ten measured samples for every case.');
    }
  }
  return side.actualDevice === expectedDevice;
}

function qualityPassed(input) {
  const resultBySide = [[input.cpu, 'CPU'], [input.cuda, 'CUDA0']];
  return BENCHMARK_CASES.every((benchmarkCase) => resultBySide.every(([side, expectedDevice]) => {
    const result = side.cases.find(({ id }) => id === benchmarkCase.id);
    return result
      && result.actualDevice === expectedDevice
      && typeof result.text === 'string'
      && result.text.trim().length > 0
      && benchmarkCase.protectedTokens.every((token) => result.text.includes(token));
  }));
}

function summarizeBenchmark(input) {
  if (input?.revision !== 'b9940') throw new Error('Benchmark must use pinned llama.cpp revision b9940.');
  if (input?.modelSha256 !== MODEL_SHA256) throw new Error('Benchmark must use the pinned HY-MT2 model.');
  const cpuDevicePassed = assertEvidenceSide(input.cpu, 'CPU');
  const cudaDevicePassed = assertEvidenceSide(input.cuda, 'CUDA0');
  const cpuMedian = median(input.cpu.samples.map(({ inferenceMs }) => inferenceMs));
  const cudaMedian = median(input.cuda.samples.map(({ inferenceMs }) => inferenceMs));
  const cpuVisibleP95 = percentile(input.cpu.samples.map(({ visibleMs }) => visibleMs), 0.95);
  const cudaVisibleP95 = percentile(input.cuda.samples.map(({ visibleMs }) => visibleMs), 0.95);
  const medianImprovement = cpuMedian > 0 ? (cpuMedian - cudaMedian) / cpuMedian : 0;
  const passedQuality = cpuDevicePassed && cudaDevicePassed && qualityPassed(input);

  return {
    revision: input.revision,
    modelSha256: input.modelSha256,
    cpu: { medianInferenceMs: cpuMedian, p95VisibleMs: cpuVisibleP95 },
    cuda: { medianInferenceMs: cudaMedian, p95VisibleMs: cudaVisibleP95 },
    medianImprovement,
    qualityPassed: passedQuality,
    passed: passedQuality && medianImprovement >= 0.3 && cudaVisibleP95 <= cpuVisibleP95,
  };
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createVisibleLatencyManager(server, benchmarkCase, requestTimings, onFinal) {
  const client = { request: async (type, payload, options) => {
    const started = performance.now();
    const result = await server.translate(type, payload, options);
    requestTimings[payload.targetLanguage] = performance.now() - started;
    return result;
  } };
  const manager = new CaptionSessionManager({
    credentialStore: {},
    settingsStore: {},
    onCaption: onFinal,
  });
  manager.active = true;
  manager.sessionId = `benchmark-${benchmarkCase.id}`;
  manager.settings = {
    primaryProfile: 'economy',
    glossary: [],
    customGlossaryConfiguration: null,
    protectedTokens: benchmarkCase.protectedTokens,
    fastPath: false,
    provisionalTranslation: false,
  };
  manager.processing = { transcription: 'whisper-local' };
  manager.translationPolicy = { finalBackend: 'hy-mt2-local' };
  manager.finalTranslator = new LocalHyMt2Backend({ client, sessionId: manager.sessionId });
  manager.cost = { canSpend: () => true, snapshot: () => ({ totalUsd: 0 }) };
  return manager;
}

function runVisibleTranslation(server, benchmarkCase, runId) {
  const target = benchmarkCase.targetLanguage === 'Chinese' ? 'chinese' : 'english';
  const requestTimings = {};
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Visible caption timed out for ${benchmarkCase.id}.`));
    }, 60_000);
    const manager = createVisibleLatencyManager(server, benchmarkCase, requestTimings, (caption) => {
      if (settled || caption[target]?.status !== 'final') return;
      settled = true;
      clearTimeout(timer);
      resolve({
        id: benchmarkCase.id,
        text: caption[target].text,
        actualDevice: caption.provider.finalNormalizationDevice,
        inferenceMs: caption.provider.finalNormalizationInferenceMs,
        requestMs: requestTimings[benchmarkCase.targetLanguage],
        visibleMs: performance.now() - started,
      });
    });
    try {
      manager.releaseFinalTranscript({
        channel: 'microphone',
        itemId: `${benchmarkCase.id}-${runId}`,
        transcript: benchmarkCase.text,
        final: true,
        startedAt: Date.now(),
        at: Date.now(),
        model: 'whisper-small',
        runtime: 'openvino-genai',
        actualDevice: 'NPU',
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function benchmarkFamily({ family, binaryPath, modelPath, repetitions = MIN_REPETITIONS }) {
  const runtimeDescriptor = family === 'cuda' ? CUDA_RUNTIME : CPU_RUNTIME;
  const server = new LlamaTranslationServer({ binaryPath, modelPath, runtimeDescriptor, maxRestarts: 0 });
  try {
    const health = await server.start();
    await runVisibleTranslation(server, BENCHMARK_CASES[0], `${family}-warmup`);
    const cases = [];
    for (const benchmarkCase of BENCHMARK_CASES) {
      cases.push(await runVisibleTranslation(server, benchmarkCase, `${family}-quality`));
    }
    const samples = [];
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      for (const benchmarkCase of BENCHMARK_CASES) {
        const result = await runVisibleTranslation(server, benchmarkCase, `${family}-${repetition}`);
        samples.push({
          caseId: benchmarkCase.id,
          repetition,
          inferenceMs: result.inferenceMs,
          requestMs: result.requestMs,
          visibleMs: result.visibleMs,
        });
      }
    }
    return { actualDevice: health.actualDevice, loadMs: health.loadMs, cases, samples };
  } finally {
    await server.stop();
  }
}

async function main() {
  const required = ['TWINSCRIPT_LLAMA_CPU_SERVER', 'TWINSCRIPT_LLAMA_CUDA_SERVER', 'TWINSCRIPT_HYMT2_MODEL'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    console.log(`SKIP: missing ${missing.join(', ')}`);
    return;
  }
  const modelPath = path.resolve(process.env.TWINSCRIPT_HYMT2_MODEL);
  const input = {
    revision: 'b9940',
    modelSha256: sha256(modelPath),
    cpu: await benchmarkFamily({
      family: 'cpu', binaryPath: path.resolve(process.env.TWINSCRIPT_LLAMA_CPU_SERVER), modelPath,
    }),
    cuda: await benchmarkFamily({
      family: 'cuda', binaryPath: path.resolve(process.env.TWINSCRIPT_LLAMA_CUDA_SERVER), modelPath,
    }),
  };
  const summary = summarizeBenchmark(input);
  if (!summary.qualityPassed) {
    throw new Error('HY-MT2 benchmark quality or runtime provenance failed; evidence was not published.');
  }
  const outputPath = path.resolve(process.env.TWINSCRIPT_HYMT2_BENCHMARK_OUTPUT || 'artifacts/local-inference/hymt2-cuda.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ ...summary, evidence: input }, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, outputPath);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.passed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  BENCHMARK_CASES,
  MODEL_SHA256,
  benchmarkFamily,
  main,
  summarizeBenchmark,
};
