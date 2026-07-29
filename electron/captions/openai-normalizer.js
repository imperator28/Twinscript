const TARGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['source_language', 'text'],
  properties: {
    source_language: {
      type: 'string',
      enum: ['en', 'zh', 'mixed', 'unknown'],
    },
    text: { type: 'string' },
  },
};

const PROFILE_MODELS = Object.freeze({
  economy: { provisional: 'gpt-5.4-nano', final: 'gpt-5.4-nano' },
  tiered: { provisional: 'gpt-5.4-nano', final: 'gpt-5.6-luna' },
  quality: { provisional: 'gpt-5.6-luna', final: 'gpt-5.6-luna' },
});

function extractResponseText(payload) {
  if (payload.output_text) return payload.output_text;
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) return content.text;
    }
  }
  return '';
}

function glossaryPrompt(glossary) {
  const rows = (glossary || [])
    .slice(0, 40)
    .map((entry) => {
      const suffix = entry.doNotTranslate ? ' [keep verbatim]' : '';
      return `${entry.en || ''} = ${entry.zh || ''}${suffix}`.trim();
    })
    .filter(Boolean);
  return rows.length ? `\nTerminology:\n${rows.join('\n')}` : '';
}

class OpenAINormalizer {
  constructor({ apiKey, fetchImpl = global.fetch, onUsage = () => {} }) {
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.onUsage = onUsage;
  }

  async normalize({
    sourceText,
    target,
    profile,
    final,
    glossary,
    signal,
  }) {
    const model =
      (PROFILE_MODELS[profile] || PROFILE_MODELS.economy)[
        final ? 'final' : 'provisional'
      ];
    const targetLabel =
      target === 'zh' ? 'Simplified Chinese' : 'natural professional English';
    const response = await this.fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        store: false,
        reasoning: { effort: 'none' },
        max_output_tokens: 180,
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text:
                  `Translate or normalize one live engineering-meeting utterance into ${targetLabel}. ` +
                  'Preserve dimensions, tolerances, units, part numbers, acronyms, speaker intent, and uncertainty. ' +
                  'If the input already uses the target language, lightly normalize punctuation without changing meaning. ' +
                  'Return only the requested structured object.' +
                  glossaryPrompt(glossary),
              },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: sourceText }],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'normalized_caption',
            strict: true,
            schema: TARGET_SCHEMA,
          },
          verbosity: 'low',
        },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const error = new Error(`Normalization failed (${response.status})`);
      error.code = response.status === 429 ? 'rate_limited' : 'normalization_failed';
      error.safeDetail = errorBody.slice(0, 300).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]');
      throw error;
    }

    const payload = await response.json();
    const parsed = JSON.parse(extractResponseText(payload));
    const inputTokens = payload.usage?.input_tokens || 0;
    const cachedInputTokens =
      payload.usage?.input_tokens_details?.cached_tokens || 0;
    const outputTokens = payload.usage?.output_tokens || 0;
    this.onUsage({ model, inputTokens, cachedInputTokens, outputTokens });
    return {
      model,
      sourceLanguage: parsed.source_language,
      text: String(parsed.text || '').trim(),
      usage: { inputTokens, cachedInputTokens, outputTokens },
      requestId: response.headers.get('x-request-id') || undefined,
    };
  }
}

module.exports = {
  OpenAINormalizer,
  PROFILE_MODELS,
  TARGET_SCHEMA,
  extractResponseText,
  glossaryPrompt,
};
