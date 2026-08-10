const crypto = require('crypto');
const { OpenAINormalizer } = require('./openai-normalizer');

const LANGUAGE_NAMES = {
  en: 'English',
  zh: 'Chinese',
};

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
    signal,
    utteranceId = crypto.randomUUID(),
    sourceRevision = 0,
  }) {
    const message = await this.client.request(
      final ? 'translate.final' : 'translate.preview',
      {
        sessionId: this.sessionId,
        utteranceId,
        sourceRevision,
        sourceLanguage: LANGUAGE_NAMES[sourceLanguage] || sourceLanguage || 'Auto',
        targetLanguage: LANGUAGE_NAMES[target] || target,
        text: sourceText,
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
  LocalHyMt2Backend,
  TranslationBackendFactory,
};
