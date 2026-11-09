// Explicitly opt-in evaluation. No production settings changed. No .env loading.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
const require = createRequire(import.meta.url);
const { EvaluationBudget, acousticScores, loadAudioManifest, geminiSetup, geminiTranscripts, missingLiterals } = require('./release-eval-lib.cjs');
const { OpenAINormalizer } = require('../electron/captions/openai-normalizer');
const { LiveTranscriptionSession } = require('../electron/captions/live-transcription-session');
const { missingCriticalValues, wrongAudienceLanguage, percentile } = require('../electron/captions/corpus-metrics');
const { missingProtectedTokens } = require('../electron/captions/quality-signals');
const PRICES = { 'gpt-5.4-nano': [0.2, 0.02, 1.25], 'gpt-5.6-luna': [0.2, 0.02, 1.2], 'gpt-6-luna': [0.1, 0.01, 0.5] };
const args = { live: false, mode: 'translation', limit: 8, out: '', audioManifest: '', consentedAudio: false };
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (flag === '--live') args.live = true;
  else if (flag === '--dry-run') args.live = false;
  else if (flag === '--consented-audio') args.consentedAudio = true;
  else if (flag === '--mode') args.mode = process.argv[++i];
  else if (flag === '--max-usd') args.maxUsd = Number(process.argv[++i]);
  else if (flag === '--limit') args.limit = Number(process.argv[++i]);
  else if (flag === '--out') args.out = process.argv[++i];
  else if (flag === '--audio-manifest') args.audioManifest = process.argv[++i];
  else throw new Error('Unknown evaluation option');
}
if (!['translation', 'asr'].includes(args.mode) || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 256) throw new Error('Invalid mode or limit (1–256)');
const report = { schemaVersion: 1, mode: args.mode, live: args.live, measured: false,
  latencyBasis: 'request-start-or-ASR-setup-start-not-acoustic', longSessionBehavior: 'unmeasured', results: [] };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let budget;
if (args.live) {
  budget = new EvaluationBudget(args.maxUsd);
  if (!args.out) throw new Error('Live evaluation requires a local --out path');
  if (!process.env.OPENAI_API_KEY || (args.mode === 'asr' && !process.env.GEMINI_API_KEY)) throw new Error('Required provider secret is not configured');
  if (process.env.CI) throw new Error('Paid evaluation must run outside artifact-producing CI');
}

async function corpus() {
  const ts = await import('typescript');
  const source = fs.readFileSync(new URL('../src/captions/screeningCorpus.ts', import.meta.url), 'utf8');
  const output = ts.default.transpileModule(source, { compilerOptions: { module: ts.default.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} }; new Function('module', 'exports', output)(mod, mod.exports);
  // Round-robin the four language classes, including both channel labels.
  const rows = mod.exports.SCREENING_CORPUS.slice(0, args.limit);
  rows.push({ id: 'long-mixed-engineering', sourceChannel: 'microphone', languageClass: 'mixed-inline',
    sourceText: 'Please confirm EVT T1: 壁厚 2.5 mm，公差 0.05 mm。DVT T2 must follow Rev C. '.repeat(12),
    protectedTokens: ['EVT', 'DVT', 'T1', 'T2', 'Rev C'] });
  return rows;
}
async function translations() {
  const rows = await corpus();
  report.plan = { syntheticTextOnly: true, prompts: rows.length, models: Object.keys(PRICES), targets: ['en', 'zh'] };
  if (!args.live) return;
  for (const row of rows) for (const model of Object.keys(PRICES)) for (const target of ['en', 'zh']) {
    let billedUsd = 0, attempts = 0;
    const normalizer = new OpenAINormalizer({ apiKey: process.env.OPENAI_API_KEY,
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body); body.model = model;
        // UTF-8 byte count conservatively bounds text tokens, including schema
        // overhead. Reserve each actual attempt; never refund an unknown bill.
        const [input, , output] = PRICES[model];
        budget.reserve(((Buffer.byteLength(JSON.stringify(body)) + 2048) * input * 1.25 + body.max_output_tokens * output) / 1e6);
        attempts++;
        return fetch(url, { ...options, body: JSON.stringify(body) });
      },
      onUsage: u => {
        const [input, cached, output] = PRICES[model];
        billedUsd += ((u.inputTokens - u.cachedInputTokens) * input + u.cachedInputTokens * cached + u.outputTokens * output) / 1e6;
      },
    });
    const started = performance.now();
    const result = { id: row.id, sourceChannel: row.sourceChannel, model, target, measured: true };
    try {
      const value = await normalizer.normalize({ sourceText: row.sourceText, target, profile: 'economy', final: true,
        protectedTokens: row.protectedTokens, signal: AbortSignal.timeout(45000) });
      Object.assign(result, { text: value.text, wrongAudienceLanguage: wrongAudienceLanguage(value.text, target),
        missingNumbers: missingCriticalValues(row.sourceText, value.text),
        missingProtectedTokens: [...new Set([...missingProtectedTokens(row.sourceText, value.text), ...missingLiterals(row.sourceText, value.text, row.protectedTokens)])] });
    } catch { result.error = 'translation_failed_or_budget_exhausted'; }
    Object.assign(result, { requestMs: performance.now() - started, attempts, reportedUsageEstimateUsd: billedUsd });
    report.results.push(result);
    save();
    if (result.error) return; // Fail closed on unknown billing or contract failures.
  }
}

async function replay(fixture, send) {
  const began = performance.now();
  for (let offset = 0; offset < fixture.pcm.length; offset += 4800) {
    await wait(Math.max(0, began + offset / 48 - performance.now()));
    send(fixture.pcm.subarray(offset, offset + 4800));
  }
  await wait(Math.max(0, began + fixture.durationMs - performance.now()));
}
async function openaiAsr(fixture, record) {
  const session = new LiveTranscriptionSession({ channel: fixture.sourceChannel, apiKey: process.env.OPENAI_API_KEY,
    settings: { vadEnabled: false, delayProfile: 'low' }, keywords: ['EVT', 'DVT', 'PVT', 'T1', 'T2'],
    onEvent: event => {
      if (event.type === 'transcript') record(event.transcript, event.final);
      if (event.type === 'error') record('', false, 'openai_asr_error');
    },
  });
  try {
    await session.connect();
    await replay(fixture, chunk => session.sendPcm(new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2)));
    await session.finish({ timeoutMs: 12000 });
  } finally { session.close(); }
  return { estimatedAudioUsd: fixture.durationMs / 60000 * 0.017 };
}
async function geminiAsr(fixture, record) {
  const socket = new WebSocket('wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
    { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY }, handshakeTimeout: 12000 });
  let ready = false, error = false, finalAt = null;
  const usage = [];
  socket.on('error', () => { error = true; });
  socket.on('close', () => { if (!finalAt) error = true; });
  socket.on('open', () => socket.send(JSON.stringify(geminiSetup())));
  socket.on('message', bytes => {
    try {
      const message = JSON.parse(bytes);
      if (message.setupComplete) ready = true;
      if (message.error || message.goAway) error = true;
      for (const event of geminiTranscripts(message)) {
        record(event.text, event.final);
        if (event.final) finalAt = performance.now();
      }
      if (message.usageMetadata) usage.push(Object.fromEntries(Object.entries(message.usageMetadata).filter(([, v]) => typeof v === 'number')));
    } catch { error = true; }
  });
  const send = realtimeInput => {
    if (error || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 512 * 1024) throw new Error('Gemini transport failed');
    socket.send(JSON.stringify({ realtimeInput }));
  };
  try {
    const deadline = performance.now() + 12000;
    while (!ready && !error && performance.now() < deadline) await wait(50);
    if (!ready || error) throw new Error('Gemini setup failed');
    send({ activityStart: {} });
    await replay(fixture, chunk => send({ audio: { data: chunk.toString('base64'), mimeType: 'audio/pcm;rate=24000' } }));
    send({ activityEnd: {} });
    const drain = performance.now() + 12000;
    while (!error && performance.now() < drain && (!finalAt || performance.now() - finalAt < 1500)) await wait(50);
    if (error || !finalAt) throw new Error('Gemini final transcript missing');
    return { usageMetadata: usage, actualCostUsd: null };
  } finally { socket.close(); }
}
async function asr() {
  if (!args.audioManifest || (args.live && !args.consentedAudio)) throw new Error('ASR requires --audio-manifest; live also requires --consented-audio');
  const fixtures = loadAudioManifest(path.resolve(args.audioManifest)).slice(0, args.limit);
  report.plan = { consentedFixtures: fixtures.length, providers: ['openai', 'gemini'], pairedPcm: true, productionCapture: false };
  if (!args.live) return;
  for (const fixture of fixtures) for (const provider of ['openai', 'gemini']) {
    // A fresh session per fixture bounds output billing. Gemini's advertised
    // blended per-minute figure is not a ceiling; reserve its full output cap.
    budget.reserve(provider === 'openai' ? fixture.durationMs / 60000 * 0.017 :
      (Math.ceil(fixture.durationMs / 1000 * 25) * 3.5 + 4096 * 21) / 1e6);
    const began = performance.now(), events = [], finals = [];
    let failed = false;
    const result = { id: fixture.id, provider, sourceChannel: fixture.sourceChannel, captureStartedAt: fixture.captureStartedAt,
      sampleStart: fixture.sampleStart, sampleEnd: fixture.sampleEnd, sampleRate: fixture.sampleRate, durationMs: fixture.durationMs, measured: true };
    const record = (text, final, error) => {
      if (error) failed = true;
      if (!text) return;
      events.push({ receivedMs: performance.now() - began, final });
      if (final) finals.push(text);
    };
    try { Object.assign(result, await (provider === 'openai' ? openaiAsr : geminiAsr)(fixture, record)); }
    catch { failed = true; }
    const transcript = finals.join(' ');
    Object.assign(result, { error: failed || !finals.length ? 'asr_failed_or_final_missing' : null,
      ...acousticScores(fixture.reference, transcript),
      missingNumbers: missingCriticalValues(fixture.reference, transcript),
      missingProtectedTokens: [...new Set([...missingProtectedTokens(fixture.reference, transcript), ...missingLiterals(fixture.reference, transcript, ['EVT', 'DVT', 'PVT', 'T1', 'T2'])])],
      firstTextMs: events[0]?.receivedMs ?? null, finalTextMs: events.filter(e => e.final).at(-1)?.receivedMs ?? null,
      interimUpdates: events.filter(e => !e.final).length, finalSegments: finals.length });
    // Audio and transcripts stay out of the report. Retain only scores/provenance.
    report.results.push(result); save();
    if (result.error) return;
  }
}
function save() {
  report.measured = args.live && report.results.length > 0;
  report.budget = budget ? { maxUsd: budget.maxUsd, reservedUpperBoundUsd: budget.reservedUsd } : null;
  const timings = report.results.filter(r => !r.error).map(r => r.requestMs ?? r.finalTextMs).filter(Number.isFinite);
  report.latency = { p50Ms: timings.length ? percentile(timings, 0.5) : null, p95Ms: timings.length ? percentile(timings, 0.95) : null };
  report.groups = {};
  for (const row of report.results) {
    const key = row.model ? `${row.model}/${row.target}` : row.provider;
    const group = report.groups[key] ||= { attempted: 0, failed: 0, timings: [] };
    group.attempted++; if (row.error) group.failed++;
    else group.timings.push(row.requestMs ?? row.finalTextMs);
  }
  for (const group of Object.values(report.groups)) {
    group.p50Ms = group.timings.length ? percentile(group.timings, 0.5) : null;
    group.p95Ms = group.timings.length ? percentile(group.timings, 0.95) : null;
    delete group.timings;
  }
  if (args.out) {
    const target = path.resolve(args.out);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(target, 0o600);
  }
}
try {
  await (args.mode === 'translation' ? translations : asr)(); save();
  console.log(JSON.stringify({ mode: report.mode, measured: report.measured, plan: report.plan, completed: report.results.length,
    failures: report.results.filter(r => r.error).length, budget: report.budget }));
  if (report.results.some(r => r.error)) process.exitCode = 1;
} catch {
  save(); console.error('Evaluation stopped: invalid fixture, provider contract, transport, or budget. No provider payload logged.'); process.exitCode = 1;
}
