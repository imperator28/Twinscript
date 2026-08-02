// W1 language-behaviour corpus runner.
//
// Drives the scripted screening corpus through the *real* normalizer, with the
// real glossary request-context compiler and the product's own quality
// primitives, and measures the release thresholds in
// docs/windows/validation-matrix.md § "W1 — Language behavior".
//
// SCOPE — read this before trusting a PASS.
//
// This exercises the translation path only: source text in, both audience
// projections out. It deliberately does NOT cover
//   * speech recognition accuracy (no audio is synthesised or captured),
//   * dropped-audio rate or capture health,
//   * duplicate visible-entry suppression,
//   * end-to-end latency from spoken word to rendered overlay.
// Those remain manual and are only satisfied by the W3 60-minute soak. What
// this removes is the manual grind of judging, for every corpus utterance,
// whether each audience got the right language, kept its numbers, and
// preserved protected tokens.
//
// Latency here is per-utterance normalizer round-trip under a parallel load of
// --concurrency, which is not the same as the serial latency a single speaker
// experiences. Treat it as an upper bound on the model's contribution.
//
// Usage:
//   node scripts/run-w1-corpus.mjs --dry-run              # no API calls, no key
//   node scripts/run-w1-corpus.mjs --mock                 # exercise the full
//         pipeline offline, answering every request with the corpus's own
//         reference translation. Verifies the runner, not the model: a --mock
//         run that does not PASS means this script is broken.
//   node scripts/run-w1-corpus.mjs --limit 24             # smoke run
//   node scripts/run-w1-corpus.mjs --out docs/windows/evidence/w1.json
//
// The API key is read from OPENAI_API_KEY or .env.local and is never logged.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { OpenAINormalizer } = require('../electron/captions/openai-normalizer.js');
const { PriorityTaskQueue } = require('../electron/captions/priority-task-queue.js');
const { compileGlossarySelection } = require('../electron/captions/glossary-config.js');
const {
  compileGlossaryRequestContext,
  MAX_GLOSSARY_ROWS,
} = require('../electron/captions/glossary-request-context.js');
const { missingProtectedTokens } = require('../electron/captions/quality-signals.js');
const {
  missingCriticalValues,
  wrongAudienceLanguage,
  percentile,
} = require('../electron/captions/corpus-metrics.js');

// Thresholds from the validation matrix. Kept literal so a run either passes
// the documented gate or does not; they are never tuned to observed results.
const THRESHOLDS = {
  wrongAudienceLanguageRate: 0,
  protectedTokenPreservation: 1,
  criticalValueErrorRate: 0.01,
  medianLatencyMs: 2500,
  p95LatencyMs: 5000,
};

function parseArgs(argv) {
  const args = {
    limit: 0, out: '', concurrency: 4, dryRun: false, mock: false, profile: 'economy',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=');
    const value = inline ?? argv[i + 1];
    const consume = () => { if (!inline) i += 1; };
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--mock') args.mock = true;
    else if (flag === '--limit') { args.limit = Number(value); consume(); }
    else if (flag === '--out') { args.out = String(value); consume(); }
    else if (flag === '--concurrency') { args.concurrency = Number(value); consume(); }
    else if (flag === '--profile') { args.profile = String(value); consume(); }
    else if (flag === '--help' || flag === '-h') { args.help = true; }
    else throw new Error(`unknown flag: ${flag}`);
  }
  return args;
}

function readApiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  const envFile = path.resolve('.env.local');
  if (fs.existsSync(envFile)) {
    const match = fs.readFileSync(envFile, 'utf8').match(/^OPENAI_API_KEY\s*=\s*(.+)$/m);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

// The corpus is TypeScript and this runner is plain Node, so transpile it with
// the esbuild that already ships inside Vite. Using the real transformer rather
// than regex-stripping types means the runner reads the same corpus the app
// does, and fails loudly if that file ever stops being plain data.
async function loadCorpus() {
  const esbuild = require('esbuild');
  const file = path.resolve('src/captions/screeningCorpus.ts');
  const { code } = await esbuild.transform(fs.readFileSync(file, 'utf8'), {
    loader: 'ts',
    format: 'cjs',
    target: 'node20',
    sourcefile: file,
  });
  const module$ = { exports: {} };
  new Function('module', 'exports', 'require', code)(module$, module$.exports, require);
  const { SCREENING_CORPUS, SCREENING_CORPUS_SUMMARY } = module$.exports;
  if (!Array.isArray(SCREENING_CORPUS) || !SCREENING_CORPUS.length) {
    throw new Error(`${file} did not export a non-empty SCREENING_CORPUS`);
  }
  return { SCREENING_CORPUS, SCREENING_CORPUS_SUMMARY };
}

/**
 * Offline transport that answers every normalizer request with the corpus's
 * own reference translation for that source text.
 *
 * This validates the runner end to end — scheduler, request construction,
 * response parsing, metrics, gates, report rendering — without a key or a
 * charge. It says nothing about model quality: the answers are correct by
 * construction, so `--mock` failing means the *script* is wrong.
 */
function createMockFetch(corpus) {
  const bySource = new Map(corpus.map((p) => [p.sourceText, p]));
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const sourceText = body.input.at(-1).content[0].text;
    const system = body.input[0].content[0].text;
    const wantsChinese = /Chinese|中文/i.test(system);
    const prompt = bySource.get(sourceText);
    const text = (wantsChinese ? prompt?.chineseReference : prompt?.englishReference)
      ?? sourceText;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'mock-request' },
      async json() {
        return {
          output_text: JSON.stringify({ text }),
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      },
      async text() { return ''; },
    };
  };
}

function requestContextFor(prompt, settings) {
  return compileGlossaryRequestContext({
    sourceText: prompt.sourceText,
    glossary: settings.glossary,
    protectedTokens: settings.protectedTokens,
  });
}

function runDryRun(corpus, settings) {
  let maxRows = 0;
  let maxChars = 0;
  const notes = [];
  for (const prompt of corpus) {
    for (const field of ['id', 'sourceText', 'languageClass']) {
      if (!prompt[field]) throw new Error(`prompt ${prompt.id}: missing ${field}`);
    }
    const context = requestContextFor(prompt, settings);
    maxRows = Math.max(maxRows, context.metrics.glossaryRows);
    maxChars = Math.max(maxChars, context.metrics.promptCharacters);

    // Self-check: score the corpus's own reference answers with the same
    // detectors used on model output. A reference that trips a detector means
    // the detector is wrong, or the reference is — either way, worth knowing
    // before a real run reports it as a model failure.
    if (prompt.englishReference && wrongAudienceLanguage(prompt.englishReference, 'en')) {
      notes.push(`${prompt.id}: englishReference scores as wrong-audience`);
    }
    if (prompt.chineseReference && wrongAudienceLanguage(prompt.chineseReference, 'zh')) {
      notes.push(`${prompt.id}: chineseReference scores as wrong-audience`);
    }
    for (const [label, reference] of [
      ['englishReference', prompt.englishReference],
      ['chineseReference', prompt.chineseReference],
    ]) {
      if (!reference) continue;
      const lost = missingCriticalValues(prompt.sourceText, reference);
      if (lost.length) notes.push(`${prompt.id}: ${label} drops value ${lost.join(', ')}`);
      // The product's own protected-token check, run against the reference.
      // A reference that fails it means a perfect translation would still be
      // scored as a defect, so the gate could never reach 100%.
      const lostTokens = missingProtectedTokens(prompt.sourceText, reference);
      if (lostTokens.length) {
        notes.push(`${prompt.id}: ${label} drops token ${lostTokens.join(', ')}`);
      }
    }
  }
  console.log(`dry run OK — ${corpus.length} prompts validated`);
  console.log(`  max glossary rows per request:  ${maxRows} (limit ${MAX_GLOSSARY_ROWS})`);
  console.log(`  max glossary prompt characters: ${maxChars}`);
  if (notes.length) {
    console.log(`\n  ${notes.length} reference self-check note(s):`);
    for (const note of notes.slice(0, 20)) console.log(`    ${note}`);
    if (notes.length > 20) console.log(`    ... and ${notes.length - 20} more`);
    console.log(
      '\n  These are corpus/detector disagreements, not model failures. Each one'
      + '\n  is a prompt whose own reference answer would be scored as a defect,'
      + '\n  so the gate cannot reach 100% until the corpus or the detector moves.',
    );
  }
  console.log('\nNo API calls made. Re-run without --dry-run to measure the gate.');
  return notes;
}

function summarize(results, corpusLength, usage) {
  const ok = results.filter((r) => !r.error);
  const latencies = ok.map((r) => r.latencyMs);
  return {
    prompts: corpusLength,
    completed: ok.length,
    errored: results.length - ok.length,
    wrongAudienceLanguageRate: ok.length
      ? ok.filter((r) => r.wrongAudience).length / ok.length
      : 1,
    protectedTokenPreservation: ok.length
      ? ok.filter((r) => !r.missingProtected.length).length / ok.length
      : 0,
    criticalValueErrorRate: ok.length
      ? ok.filter((r) => r.missingValues.length).length / ok.length
      : 1,
    medianLatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    maxGlossaryRows: ok.length ? Math.max(...ok.map((r) => r.glossaryRows)) : 0,
    tokensIn: usage.in,
    tokensOut: usage.out,
  };
}

function gatesFor(metrics) {
  const pct = (v) => (v === null ? 'n/a' : `${(v * 100).toFixed(2)}%`);
  const ms = (v) => (v === null ? 'n/a' : `${v} ms`);
  return [
    {
      name: 'Wrong-audience language rate',
      shown: pct(metrics.wrongAudienceLanguageRate),
      need: '0%',
      pass: metrics.wrongAudienceLanguageRate <= THRESHOLDS.wrongAudienceLanguageRate,
    },
    {
      name: 'Protected-token preservation',
      shown: pct(metrics.protectedTokenPreservation),
      need: '100%',
      pass: metrics.protectedTokenPreservation >= THRESHOLDS.protectedTokenPreservation,
    },
    {
      name: 'Critical value error rate',
      shown: pct(metrics.criticalValueErrorRate),
      need: '< 1%',
      pass: metrics.criticalValueErrorRate <= THRESHOLDS.criticalValueErrorRate,
    },
    {
      name: 'Median normalizer latency',
      shown: ms(metrics.medianLatencyMs),
      need: '<= 2500 ms',
      pass: metrics.medianLatencyMs !== null
        && metrics.medianLatencyMs <= THRESHOLDS.medianLatencyMs,
    },
    {
      name: 'p95 normalizer latency',
      shown: ms(metrics.p95LatencyMs),
      need: '<= 5000 ms',
      pass: metrics.p95LatencyMs !== null
        && metrics.p95LatencyMs <= THRESHOLDS.p95LatencyMs,
    },
    {
      name: 'Glossary rows per request',
      shown: String(metrics.maxGlossaryRows),
      need: `<= ${MAX_GLOSSARY_ROWS}`,
      pass: metrics.maxGlossaryRows <= MAX_GLOSSARY_ROWS,
    },
    {
      name: 'Requests completed without error',
      shown: `${metrics.completed}/${metrics.prompts}`,
      need: 'all',
      pass: metrics.errored === 0 && metrics.completed === metrics.prompts,
    },
  ];
}

function renderMarkdown({ metrics, gates, results, args, corpusSummary, startedAt }) {
  const ok = results.filter((r) => !r.error);
  const failures = ok.filter(
    (r) => r.wrongAudience || r.missingProtected.length || r.missingValues.length,
  );
  const byClass = new Map();
  for (const r of ok) {
    const entry = byClass.get(r.languageClass) || { n: 0, bad: 0 };
    entry.n += 1;
    if (r.wrongAudience || r.missingProtected.length || r.missingValues.length) {
      entry.bad += 1;
    }
    byClass.set(r.languageClass, entry);
  }

  const lines = [];
  lines.push(`# W1 language behaviour — corpus run, ${startedAt.slice(0, 10)}`);
  lines.push('');
  lines.push(
    `**Result: ${gates.every((g) => g.pass) ? 'PASS' : 'FAIL'}** — `
    + `${metrics.completed}/${metrics.prompts} prompts, both audiences each, `
    + `profile \`${args.profile}\`, concurrency ${args.concurrency}.`,
  );
  lines.push('');
  lines.push('## Scope');
  lines.push('');
  lines.push('This measures the **translation path only**. It does not cover speech');
  lines.push('recognition accuracy, dropped-audio rate, duplicate visible entries, or');
  lines.push('spoken-word-to-overlay latency — those still require the W3 60-minute');
  lines.push('soak on real hardware. Latency below is normalizer round-trip under');
  lines.push(`${args.concurrency}-way parallel load, an upper bound on the model's`);
  lines.push('contribution rather than what one speaker experiences.');
  lines.push('');
  lines.push('Wrong-audience detection uses the product\'s own script classifier, which');
  lines.push('reports mixed-script and too-short output as *not* wrong. The rate below');
  lines.push('is therefore a floor.');
  lines.push('');
  lines.push('## Thresholds');
  lines.push('');
  lines.push('| Gate | Measured | Required | |');
  lines.push('| --- | ---: | ---: | :--: |');
  for (const g of gates) {
    lines.push(`| ${g.name} | ${g.shown} | ${g.need} | ${g.pass ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('');
  lines.push('## By language class');
  lines.push('');
  lines.push('| Class | Prompts | With any defect |');
  lines.push('| --- | ---: | ---: |');
  for (const [cls, e] of [...byClass].sort()) {
    lines.push(`| ${cls} | ${e.n} | ${e.bad} |`);
  }
  lines.push('');
  lines.push('## Corpus');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(corpusSummary, null, 2));
  lines.push('```');
  lines.push('');
  lines.push(`## Defects (${failures.length})`);
  lines.push('');
  if (!failures.length) {
    lines.push('None.');
  } else {
    for (const r of failures.slice(0, 40)) {
      const why = [
        r.wrongAudience && 'wrong audience language',
        r.missingProtected.length && `lost tokens ${r.missingProtected.join(', ')}`,
        r.missingValues.length && `lost values ${r.missingValues.join(', ')}`,
      ].filter(Boolean).join('; ');
      lines.push(`### \`${r.id}\` — ${why}`);
      lines.push('');
      lines.push(`- source: ${r.sourceText}`);
      lines.push(`- en: ${r.english}`);
      lines.push(`- zh: ${r.chinese}`);
      lines.push('');
    }
    if (failures.length > 40) {
      lines.push(`_${failures.length - 40} further defects in the JSON report._`);
      lines.push('');
    }
  }
  const errored = results.filter((r) => r.error);
  if (errored.length) {
    lines.push(`## Errored requests (${errored.length})`);
    lines.push('');
    for (const r of errored.slice(0, 20)) lines.push(`- \`${r.id}\`: ${r.error}`);
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push(`Generated by \`scripts/run-w1-corpus.mjs\` at ${startedAt}.`);
  lines.push(`Tokens in/out: ${metrics.tokensIn}/${metrics.tokensOut}.`);
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8')
      .split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return 0;
  }

  const { SCREENING_CORPUS, SCREENING_CORPUS_SUMMARY } = await loadCorpus();
  const corpus = args.limit > 0 ? SCREENING_CORPUS.slice(0, args.limit) : SCREENING_CORPUS;
  const settings = compileGlossarySelection('universal-engineering', null);

  console.log(`corpus:   ${corpus.length} of ${SCREENING_CORPUS.length} prompts`);
  console.log(`glossary: ${settings.glossary.length} active terms`);
  console.log(`profile:  ${args.profile}, concurrency ${args.concurrency}\n`);

  if (args.dryRun) {
    runDryRun(corpus, settings);
    return 0;
  }

  const apiKey = args.mock ? 'mock' : readApiKey();
  if (!apiKey) {
    console.error(
      'No API key. Set OPENAI_API_KEY, or add it to .env.local (gitignored).\n'
      + 'Run with --dry-run to validate the corpus without calling the API.',
    );
    return 2;
  }
  if (args.mock) {
    console.log('MOCK MODE — answering from corpus references. Measures the\n'
      + 'runner, not the model. Results are not evidence.\n');
  }

  const startedAt = new Date().toISOString();
  const usage = { in: 0, out: 0 };
  const scheduler = new PriorityTaskQueue({
    concurrency: args.concurrency,
    maxQueue: corpus.length * 2 + 16,
  });
  const normalizer = new OpenAINormalizer({
    apiKey,
    scheduler,
    ...(args.mock ? { fetchImpl: createMockFetch(corpus) } : {}),
    onUsage: (u) => {
      usage.in += u?.inputTokens || 0;
      usage.out += u?.outputTokens || 0;
    },
  });

  const results = [];
  let done = 0;
  await Promise.all(corpus.map(async (prompt) => {
    // Same request-context compilation the live session performs, so glossary
    // selection and budget bounds are exercised exactly as in production.
    const context = requestContextFor(prompt, settings);
    const startedMs = Date.now();
    try {
      const [english, chinese] = await Promise.all(['en', 'zh'].map((target) =>
        normalizer.normalize({
          sourceText: prompt.sourceText,
          target,
          profile: args.profile,
          final: true,
          glossary: context.glossary,
          protectedTokens: context.protectedTokens,
          priority: 10,
        })));
      const en = english?.text ?? '';
      const zh = chinese?.text ?? '';
      results.push({
        id: prompt.id,
        languageClass: prompt.languageClass,
        condition: prompt.condition,
        critical: Boolean(prompt.critical),
        sourceText: prompt.sourceText,
        english: en,
        chinese: zh,
        latencyMs: Date.now() - startedMs,
        glossaryRows: context.metrics.glossaryRows,
        promptCharacters: context.metrics.promptCharacters,
        wrongAudience: wrongAudienceLanguage(en, 'en') || wrongAudienceLanguage(zh, 'zh'),
        missingProtected: [...new Set([
          ...missingProtectedTokens(prompt.sourceText, en),
          ...missingProtectedTokens(prompt.sourceText, zh),
        ])],
        missingValues: [...new Set([
          ...missingCriticalValues(prompt.sourceText, en),
          ...missingCriticalValues(prompt.sourceText, zh),
        ])],
        error: null,
      });
    } catch (error) {
      results.push({
        id: prompt.id,
        languageClass: prompt.languageClass,
        latencyMs: Date.now() - startedMs,
        error: error?.message || String(error),
      });
    }
    done += 1;
    if (done % 20 === 0 || done === corpus.length) {
      process.stdout.write(`  ${done}/${corpus.length}\n`);
    }
  }));

  const metrics = summarize(results, corpus.length, usage);
  const gates = gatesFor(metrics);

  console.log('\n--- W1 language behaviour ---');
  for (const g of gates) {
    console.log(
      `  ${g.pass ? 'PASS' : 'FAIL'}  ${g.name.padEnd(34)}`
      + `${g.shown.padStart(12)}   (need ${g.need})`,
    );
  }
  console.log(`\n  tokens in/out: ${metrics.tokensIn}/${metrics.tokensOut}`);

  const defects = results.filter(
    (r) => !r.error && (r.wrongAudience || r.missingProtected.length || r.missingValues.length),
  );
  for (const r of defects.slice(0, 8)) {
    const why = [
      r.wrongAudience && 'wrong-audience',
      r.missingProtected.length && `tokens:${r.missingProtected.join('|')}`,
      r.missingValues.length && `values:${r.missingValues.join('|')}`,
    ].filter(Boolean).join(' ');
    console.log(`    [${r.id}] ${why}`);
  }
  if (defects.length > 8) console.log(`    ... ${defects.length - 8} more`);

  if (args.out) {
    const jsonPath = path.resolve(args.out);
    const mdPath = jsonPath.replace(/\.json$/i, '') + '.md';
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, `${JSON.stringify({
      startedAt,
      args: { limit: args.limit, concurrency: args.concurrency, profile: args.profile },
      thresholds: THRESHOLDS,
      metrics,
      gates,
      corpusSummary: SCREENING_CORPUS_SUMMARY,
      results,
    }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(mdPath, renderMarkdown({
      metrics, gates, results, args, corpusSummary: SCREENING_CORPUS_SUMMARY, startedAt,
    }), 'utf8');
    console.log(`\n  report: ${args.out}`);
    console.log(`  report: ${path.relative(process.cwd(), mdPath)}`);
  }

  return gates.every((g) => g.pass) ? 0 : 1;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => { console.error(error); process.exitCode = 2; },
);
