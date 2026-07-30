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

function glossaryPrompt(glossary, protectedTokens = []) {
  const rows = (glossary || [])
    .slice(0, 40)
    .map((entry) => {
      const suffix = entry.doNotTranslate ? ' [keep verbatim]' : '';
      return `${entry.en || ''} = ${entry.zh || ''}${suffix}`.trim();
    })
    .filter(Boolean);
  const tokens = [
    ...new Set(
      (protectedTokens || [])
        .map((token) => String(token || '').trim())
        .filter(Boolean),
    ),
  ].slice(0, 80);
  const sections = [];
  if (rows.length) sections.push(`Terminology:\n${rows.join('\n')}`);
  if (tokens.length) {
    sections.push(
      `Protected literal tokens (keep this exact canonical spelling in every language): ${tokens.join(', ')}`,
    );
  }
  return sections.length ? `\n${sections.join('\n')}` : '';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function protectedTokenPattern(token) {
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])(${escapeRegExp(token)})(?=$|[^\\p{L}\\p{N}])`,
    'giu',
  );
}

function findProtectedTokens(text, protectedTokens) {
  const source = String(text || '');
  return (protectedTokens || []).filter((token) => {
    const canonical = String(token || '').trim();
    return canonical && protectedTokenPattern(canonical).test(source);
  });
}

function canonicalizeProtectedTokens(text, protectedTokens) {
  let next = String(text || '');
  for (const rawToken of protectedTokens || []) {
    const canonical = String(rawToken || '').trim();
    if (!canonical) continue;
    next = next.replace(
      protectedTokenPattern(canonical),
      (_match, prefix) => `${prefix}${canonical}`,
    );
  }
  return next;
}

function abortableDelay(durationMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('Operation aborted');
      error.name = 'AbortError';
      reject(error);
      return;
    }
    const timer = setTimeout(resolve, durationMs);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        const error = new Error('Operation aborted');
        error.name = 'AbortError';
        reject(error);
      },
      { once: true },
    );
  });
}

class OpenAINormalizer {
  constructor({
    apiKey,
    fetchImpl = global.fetch,
    onUsage = () => {},
    scheduler,
  }) {
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.onUsage = onUsage;
    this.scheduler = scheduler;
  }

  async normalize({
    sourceText,
    target,
    profile,
    final,
    glossary,
    protectedTokens,
    signal,
    priority,
  }) {
    const model =
      (PROFILE_MODELS[profile] || PROFILE_MODELS.economy)[
        final ? 'final' : 'provisional'
      ];
    const targetLabel =
      target === 'zh' ? 'Simplified Chinese' : 'natural professional English';
    const sourceProtectedTokens = findProtectedTokens(
      sourceText,
      protectedTokens,
    );
    const performRequest = async (preservationRetry = false) => {
      const retryInstruction = preservationRetry
        ? ` The source contains ${sourceProtectedTokens.join(', ')}. Include every one of those exact literal tokens in the output.`
        : '';
      const requestBody = JSON.stringify({
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
                  glossaryPrompt(glossary, protectedTokens) +
                  retryInstruction,
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
      });
      const request = () =>
        this.requestWithRetry({
          body: requestBody,
          signal,
          maxAttempts: final ? 3 : 1,
        });
      const response = this.scheduler
        ? await this.scheduler.run(request, {
            priority: priority ?? (final ? 10 : 0),
            signal,
          })
        : await request();
      const payload = await response.json();
      const parsed = JSON.parse(extractResponseText(payload));
      const usage = {
        inputTokens: payload.usage?.input_tokens || 0,
        cachedInputTokens:
          payload.usage?.input_tokens_details?.cached_tokens || 0,
        outputTokens: payload.usage?.output_tokens || 0,
      };
      this.onUsage({ model, ...usage });
      return {
        parsed,
        usage,
        requestId: response.headers.get('x-request-id') || undefined,
      };
    };

    let response = await performRequest();
    let normalizedText = canonicalizeProtectedTokens(
      response.parsed.text,
      sourceProtectedTokens,
    );
    const missingTokens = sourceProtectedTokens.filter(
      (token) => !findProtectedTokens(normalizedText, [token]).length,
    );
    let accumulatedUsage = { ...response.usage };
    if (final && missingTokens.length) {
      const retry = await performRequest(true);
      response = retry;
      normalizedText = canonicalizeProtectedTokens(
        retry.parsed.text,
        sourceProtectedTokens,
      );
      accumulatedUsage = {
        inputTokens:
          accumulatedUsage.inputTokens + retry.usage.inputTokens,
        cachedInputTokens:
          accumulatedUsage.cachedInputTokens + retry.usage.cachedInputTokens,
        outputTokens:
          accumulatedUsage.outputTokens + retry.usage.outputTokens,
      };
    }
    return {
      model,
      sourceLanguage: response.parsed.source_language,
      text: normalizedText.trim(),
      usage: accumulatedUsage,
      requestId: response.requestId,
    };
  }

  async requestWithRetry({ body, signal, maxAttempts }) {
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const response = await this.fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
      });
      if (response.ok) return response;

      const retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      const errorBody = await response.text();
      const error = new Error(`Normalization failed (${response.status})`);
      error.code =
        response.status === 429 ? 'rate_limited' : 'normalization_failed';
      error.safeDetail = errorBody
        .slice(0, 300)
        .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]');
      lastError = error;
      if (!retryable || attempt === maxAttempts - 1) throw error;
      await abortableDelay(200 * 2 ** attempt, signal);
    }
    throw lastError;
  }
}

module.exports = {
  OpenAINormalizer,
  PROFILE_MODELS,
  TARGET_SCHEMA,
  extractResponseText,
  canonicalizeProtectedTokens,
  findProtectedTokens,
  glossaryPrompt,
  abortableDelay,
};
