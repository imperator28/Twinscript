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
    this.byStage = {
      transcriptionUsd: 0,
      primaryUsd: 0,
      shadowUsd: 0,
    };
    this.warned = false;
    this.exhausted = false;
  }

  addAudio(durationMs, model = 'gpt-live-transcribe') {
    const price = MODEL_PRICING[model]?.audioPerMinute || 0;
    this.audioMs += durationMs;
    const added = (durationMs / 60000) * price;
    this.totalUsd += added;
    this.byStage.transcriptionUsd += added;
    this.checkBudget();
  }

  addTextUsage({
    model,
    inputTokens = 0,
    cachedInputTokens = 0,
    outputTokens = 0,
  }, stage = 'primary') {
    const price = MODEL_PRICING[model] || {};
    const uncached = Math.max(0, inputTokens - cachedInputTokens);
    this.inputTokens += inputTokens;
    this.cachedInputTokens += cachedInputTokens;
    this.outputTokens += outputTokens;
    this.normalizationCalls += 1;
    const added =
      (uncached / 1_000_000) * (price.inputPerMillion || 0) +
      (cachedInputTokens / 1_000_000) * (price.cachedInputPerMillion || 0) +
      (outputTokens / 1_000_000) * (price.outputPerMillion || 0);
    this.totalUsd += added;
    const key = stage === 'shadow' ? 'shadowUsd' : 'primaryUsd';
    this.byStage[key] += added;
    this.checkBudget();
  }

  /**
   * Raise or lower the cap on a running session.
   *
   * The budget was constructor-only, so the mid-meeting "+$2" control changed the stored
   * setting and nothing else: the running meter kept the old cap and a session that had
   * already stopped spending stayed stopped. Raising the cap is worthless if it cannot
   * take effect until the next meeting.
   *
   * The warned/exhausted latches are re-evaluated rather than merely cleared. Clearing them
   * unconditionally would re-warn at 75% of the new cap for spending already reported, and
   * would let a LOWERED cap leave a session spending past its limit.
   */
  setBudget(budgetUsd) {
    const next = Number(budgetUsd);
    if (!Number.isFinite(next) || next <= 0) return this.snapshot();
    this.budgetUsd = next;
    const ratio = this.totalUsd / next;
    // Latches follow the new ratio in both directions, so raising the cap genuinely
    // resumes a stopped session and lowering it stops an over-budget one.
    this.warned = ratio >= 0.75;
    this.exhausted = ratio >= 1;
    return this.snapshot();
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
      costByStage: Object.fromEntries(
        Object.entries(this.byStage).map(([key, value]) => [
          key,
          Number(value.toFixed(6)),
        ]),
      ),
    };
  }
}

module.exports = { CostMeter, MODEL_PRICING };
