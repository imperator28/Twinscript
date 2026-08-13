const crypto = require('crypto');
const { OpenAINormalizer } = require('./openai-normalizer');
const { termMatches } = require('./glossary-request-context');

const LANGUAGE_NAMES = {
  en: 'English',
  zh: 'Chinese',
};

const ENGINEERING_LITERAL_PATTERN =
  /±?\d+(?:\.\d+)?\s*(?:mm|cm|µm|um|nm|kg|mg|VDC|VAC|mA|A|V|W|kW|Hz|kHz|MHz|GHz|°C|°F|N(?:·?m)?|%)\b|\b[A-Z][A-Z0-9-]{1,11}\b/gu;

function localProtectedTokens(sourceText, configured = []) {
  const source = String(sourceText || '');
  const result = [];
  const keys = new Set();
  const add = (value) => {
    const token = String(value || '').trim();
    const key = token.toLocaleLowerCase('en-US');
    if (!token || keys.has(key) || !source.includes(token)) return;
    keys.add(key);
    result.push(token);
  };
  configured.forEach(add);
  for (const match of source.matchAll(ENGINEERING_LITERAL_PATTERN)) add(match[0]);
  return result.slice(0, 40);
}

class LocalHyMt2Backend {
  constructor({ client, sessionId }) {
    this.client = client;
    this.sessionId = sessionId;
  }

  async normalize({
    sourceText,
    sourceLanguage,
    target,
    final,
    glossary,
    protectedTokens,
    signal,
    utteranceId = crypto.randomUUID(),
    sourceRevision = 0,
  }) {
    const relevantGlossary = Array.isArray(glossary)
      ? glossary.filter((entry) => termMatches(sourceText, entry))
      : [];
    const message = await this.client.request(
      final ? 'translate.final' : 'translate.preview',
      {
        sessionId: this.sessionId,
        utteranceId,
        sourceRevision,
        sourceLanguage: LANGUAGE_NAMES[sourceLanguage] || sourceLanguage || 'Auto',
        targetLanguage: LANGUAGE_NAMES[target] || target,
        text: sourceText,
        glossary: relevantGlossary,
        protectedTokens: localProtectedTokens(sourceText, protectedTokens),
      },
      { signal },
    );
    return {
      text: message.text,
      sourceLanguage: message.sourceLanguage || sourceLanguage || 'unknown',
      model: message.model || 'hy-mt2-1.8b',
      runtime: message.runtime || 'llama.cpp',
      actualDevice: message.actualDevice || 'CPU',
      authoritative: message.authoritative === true,
      sourceRevision: message.sourceRevision,
      usage: {
        inputTokens: Number(message.inputTokens || 0),
        outputTokens: Number(message.outputTokens || message.completionTokens || 0),
      },
    };
  }
}

class TranslationBackendFactory {
  constructor({ LunaNormalizer = OpenAINormalizer } = {}) {
    this.LunaNormalizer = LunaNormalizer;
  }

  create(model, options) {
    if (model === 'hy-mt2-local') return new LocalHyMt2Backend(options);
    if (model === 'luna') return new this.LunaNormalizer(options);
    const error = new Error(`Unsupported translation model: ${model}`);
    error.code = 'unsupported_translation_model';
    throw error;
  }
}

module.exports = {
  localProtectedTokens,
  LocalHyMt2Backend,
  TranslationBackendFactory,
};
