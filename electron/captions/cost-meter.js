const MODEL_PRICING = Object.freeze({
  'gpt-live-transcribe': { audioPerMinute: 0.017 },
  'gpt-realtime-translate': { audioPerMinute: 0.034 },
  'gpt-5.4-nano': {
    inputPerMillion: 0.2,
    cachedInputPerMillion: 0.02,
    outputPerMillion: 1.25,
  },
  'gpt-5.6-luna': {
    inputPerMillion: 1,
    cachedInputPerMillion: 0.1,
    outputPerMillion: 6,
  },
});

class CostMeter {
  constructor({ budgetUsd = 5, onBudgetEvent = () => {} } = {}) {
    this.budgetUsd = budgetUsd;
    this.onBudgetEvent = onBudgetEvent;
    this.audioMs = 0;
    this.inputTokens = 0;
    this.cachedInputTokens = 0;
    this.outputTokens = 0;
    this.normalizationCalls = 0;
    this.totalUsd = 0;
    this.warned = false;
    this.exhausted = false;
  }

  addAudio(durationMs, model = 'gpt-live-transcribe') {
    const price = MODEL_PRICING[model]?.audioPerMinute || 0;
    this.audioMs += durationMs;
    this.totalUsd += (durationMs / 60000) * price;
    this.checkBudget();
  }

  addTextUsage({
    model,
    inputTokens = 0,
    cachedInputTokens = 0,
    outputTokens = 0,
  }) {
    const price = MODEL_PRICING[model] || {};
    const uncached = Math.max(0, inputTokens - cachedInputTokens);
    this.inputTokens += inputTokens;
    this.cachedInputTokens += cachedInputTokens;
    this.outputTokens += outputTokens;
    this.normalizationCalls += 1;
    this.totalUsd +=
      (uncached / 1_000_000) * (price.inputPerMillion || 0) +
      (cachedInputTokens / 1_000_000) * (price.cachedInputPerMillion || 0) +
      (outputTokens / 1_000_000) * (price.outputPerMillion || 0);
    this.checkBudget();
  }

  checkBudget() {
    const ratio = this.budgetUsd > 0 ? this.totalUsd / this.budgetUsd : 1;
    if (!this.warned && ratio >= 0.75) {
      this.warned = true;
      this.onBudgetEvent({ type: 'warning', ratio, snapshot: this.snapshot() });
    }
    if (!this.exhausted && ratio >= 1) {
      this.exhausted = true;
      this.onBudgetEvent({ type: 'exhausted', ratio, snapshot: this.snapshot() });
    }
  }

  canSpend() {
    return !this.exhausted;
  }

  snapshot() {
    return {
      budgetUsd: this.budgetUsd,
      totalUsd: Number(this.totalUsd.toFixed(6)),
      ratio: this.budgetUsd > 0 ? this.totalUsd / this.budgetUsd : 1,
      audioMs: this.audioMs,
      inputTokens: this.inputTokens,
      cachedInputTokens: this.cachedInputTokens,
      outputTokens: this.outputTokens,
      normalizationCalls: this.normalizationCalls,
    };
  }
}

module.exports = { CostMeter, MODEL_PRICING };
