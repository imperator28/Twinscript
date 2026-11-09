const fs = require('node:fs');
const path = require('node:path');

class EvaluationBudget {
  constructor(maxUsd) {
    if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 5) throw new Error('Explicit --max-usd must be > 0 and <= 5');
    this.maxUsd = maxUsd;
    this.reservedUsd = 0;
  }
  reserve(upperBoundUsd) {
    if (!Number.isFinite(upperBoundUsd) || upperBoundUsd < 0 || this.reservedUsd + upperBoundUsd > this.maxUsd) {
      throw new Error('evaluation_budget_exhausted');
    }
    // Retain reservations even after failure: a timed-out request can be billed.
    this.reservedUsd += upperBoundUsd;
  }
}
function distance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, previous[j + 1] + 1, previous[j] + (a[i] === b[j] ? 0 : 1)));
    previous = next;
  }
  return previous[b.length];
}
function acousticScores(reference, transcript) {
  const clean = s => s.toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
  const characters = Array.from(clean(reference));
  const words = s => s.toLowerCase().match(/[a-z0-9]+(?:[.-][a-z0-9]+)*|[\p{Script=Han}]/gu) || [];
  const tokens = words(reference);
  return { cer: distance(characters, Array.from(clean(transcript))) / Math.max(1, characters.length),
    mixedTokenErrorRate: distance(tokens, words(transcript)) / Math.max(1, tokens.length) };
}
function loadAudioManifest(manifestPath) {
  const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(data.fixtures) || !data.fixtures.length || data.fixtures.length > 64) throw new Error('Need 1–64 consented audio fixtures');
  const ids = new Set();
  return data.fixtures.map(f => {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(f.id) || ids.has(f.id) || f.consented !== true ||
      !['microphone', 'system'].includes(f.sourceChannel) || f.sampleRate !== 24000 ||
      !Number.isInteger(f.sampleStart) || !Number.isInteger(f.sampleEnd) || f.sampleStart < 0 || f.sampleEnd <= f.sampleStart ||
      f.sampleEnd - f.sampleStart > 288000 || (typeof f.captureStartedAt !== 'string' || !Number.isFinite(Date.parse(f.captureStartedAt))) ||
      typeof f.reference !== 'string' || !f.reference.trim() || f.reference.length > 4000 || typeof f.pcmPath !== 'string') {
      throw new Error('Invalid consent, provenance, reference or bounded 24kHz PCM range');
    }
    ids.add(f.id);
    const file = path.resolve(path.dirname(manifestPath), f.pcmPath);
    if (fs.statSync(file).size % 2 || fs.statSync(file).size < f.sampleEnd * 2) throw new Error('PCM sample range exceeds file');
    const pcm = Buffer.alloc((f.sampleEnd - f.sampleStart) * 2);
    const fd = fs.openSync(file, 'r');
    try { if (fs.readSync(fd, pcm, 0, pcm.length, f.sampleStart * 2) !== pcm.length) throw new Error('Incomplete PCM read'); }
    finally { fs.closeSync(fd); }
    return { ...f, pcm, durationMs: (f.sampleEnd - f.sampleStart) / 24 };
  });
}
function geminiSetup() {
  return { setup: { model: 'models/gemini-3.5-transcribe-live',
    generationConfig: { responseModalities: ['TEXT'], maxOutputTokens: 4096 },
    inputAudioTranscription: { languageCodes: ['en-US', 'zh-CN'], mode: 'VERBATIM', customVocabulary: ['EVT', 'DVT', 'PVT', 'T1', 'T2'] },
    realtimeInputConfig: { automaticActivityDetection: { disabled: true } } } };
}
function geminiTranscripts(message) {
  const content = message.serverContent || {};
  if (content.modelTurn?.parts?.some(p => p.inlineData)) throw new Error('Unexpected generated media in ASR-only evaluation');
  const events = [];
  if (content.interimInputTranscription?.text) events.push({ text: content.interimInputTranscription.text, final: false });
  if (content.inputTranscription?.text) events.push({ text: content.inputTranscription.text, final: true });
  return events;
}
function missingLiterals(source, target, tokens) {
  const { findProtectedTokens } = require('../electron/captions/openai-normalizer');
  return findProtectedTokens(source, tokens).filter(token => !findProtectedTokens(target, [token]).length);
}
module.exports = { missingLiterals, EvaluationBudget, acousticScores, loadAudioManifest, geminiSetup, geminiTranscripts };
