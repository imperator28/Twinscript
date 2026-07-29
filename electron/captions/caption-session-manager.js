const crypto = require('crypto');
const {
  classifyScript,
  createCaptionEvent,
  createTarget,
  updateTarget,
} = require('./caption-domain');
const { CostMeter } = require('./cost-meter');
const { LiveTranscriptionSession } = require('./live-transcription-session');
const { OpenAINormalizer } = require('./openai-normalizer');

function errorTarget(error) {
  return {
    text: '',
    status: 'failed',
    passthrough: false,
    error: {
      code: error.code || 'normalization_failed',
      message: 'Translation unavailable',
    },
  };
}

class CaptionSessionManager {
  constructor({
    credentialStore,
    settingsStore,
    onCaption = () => {},
    onStatus = () => {},
    onMetrics = () => {},
    onEvaluation = () => {},
    transcriptionFactory,
    normalizerFactory,
    evaluationRecorder,
  }) {
    this.credentialStore = credentialStore;
    this.settingsStore = settingsStore;
    this.onCaption = onCaption;
    this.onStatus = onStatus;
    this.onMetrics = onMetrics;
    this.onEvaluation = onEvaluation;
    this.transcriptionFactory =
      transcriptionFactory ||
      ((options) => new LiveTranscriptionSession(options));
    this.normalizerFactory =
      normalizerFactory || ((options) => new OpenAINormalizer(options));
    this.evaluationRecorder = evaluationRecorder;
    this.reset();
  }

  reset() {
    this.sessionId = null;
    this.settings = null;
    this.sessions = new Map();
    this.eventsByItem = new Map();
    this.history = [];
    this.sequence = 0;
    this.pendingTimers = new Map();
    this.abortControllers = new Map();
    this.primaryNormalizer = null;
    this.shadowNormalizer = null;
    this.cost = null;
    this.active = false;
    this.shadowActive = false;
    this.mockTimers = [];
    this.startedAt = null;
  }

  async start(request = {}) {
    if (this.active) await this.stop();
    this.sessionId = crypto.randomUUID();
    this.settings = { ...this.settingsStore.get(), ...(request.settings || {}) };
    this.settingsStore.set(this.settings);
    this.startedAt = Date.now();
    this.active = true;
    this.shadowActive = Boolean(this.settings.shadowEnabled);
    this.cost = new CostMeter({
      budgetUsd: this.settings.budgetUsd,
      onBudgetEvent: (event) => this.handleBudgetEvent(event),
    });

    this.onStatus({
      state: 'starting',
      sessionId: this.sessionId,
      mode: request.mode || 'live',
    });

    if (this.settings.recordEvaluation && request.mode !== 'replay') {
      await this.evaluationRecorder?.start({
        sessionId: this.sessionId,
        settings: this.settings,
      });
    }

    if (request.mode === 'replay') {
      this.onStatus({
        state: 'running',
        sessionId: this.sessionId,
        mode: 'replay',
      });
      await this.startReplaySequence(request.recordingId);
      return this.snapshot();
    }

    if (request.mode === 'mock') {
      this.onStatus({
        state: 'running',
        sessionId: this.sessionId,
        mode: 'mock',
      });
      this.startMockSequence();
      return this.snapshot();
    }

    const apiKey = await this.credentialStore.get();
    if (!apiKey) {
      this.active = false;
      throw new Error('Add an OpenAI API key before starting a live session');
    }

    const glossaryKeywords = (this.settings.glossary || []).flatMap((entry) => [
      entry.en,
      entry.zh,
      ...(entry.aliases || []),
    ]);
    const normalizerOptions = {
      apiKey,
      onUsage: (usage) => {
        this.cost.addTextUsage(usage);
        this.emitMetrics();
      },
    };
    this.primaryNormalizer = this.normalizerFactory(normalizerOptions);
    this.shadowNormalizer = this.normalizerFactory(normalizerOptions);

    for (const channel of ['microphone', 'system']) {
      const session = this.transcriptionFactory({
        channel,
        apiKey,
        settings: this.settings,
        keywords: glossaryKeywords,
        onUsage: ({ audioMs }) => {
          this.cost.addAudio(audioMs);
          this.emitMetrics();
        },
        onEvent: (event) => this.handleTranscriptionEvent(event),
      });
      this.sessions.set(channel, session);
    }

    try {
      await Promise.all([...this.sessions.values()].map((session) => session.connect()));
      this.onStatus({
        state: 'running',
        sessionId: this.sessionId,
        mode: 'live',
      });
      return this.snapshot();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  appendAudio({ channel, samples }) {
    if (!this.active) return;
    const session = this.sessions.get(channel);
    if (!session) return;
    const pcm =
      samples instanceof Int16Array
        ? samples
        : ArrayBuffer.isView(samples)
          ? new Int16Array(samples.buffer, samples.byteOffset, samples.byteLength / 2)
          : new Int16Array(samples);
    if (this.settings?.recordEvaluation) {
      this.evaluationRecorder?.record('audio', {
        channel,
        samples: Buffer.from(
          pcm.buffer,
          pcm.byteOffset,
          pcm.byteLength,
        ).toString('base64'),
      });
    }
    session.appendAudio(pcm);
  }

  handleTranscriptionEvent(event) {
    if (!this.active) return;
    if (event.type === 'level') {
      this.onMetrics({
        ...this.cost.snapshot(),
        levels: { [event.channel]: event.rms },
        speaking: { [event.channel]: event.speaking },
      });
      return;
    }
    if (event.type === 'connection' || event.type === 'error') {
      this.onStatus({
        state: event.type === 'error' ? 'degraded' : event.status,
        sessionId: this.sessionId,
        channel: event.channel,
        code: event.code,
        message: event.message,
      });
      return;
    }
    if (event.type !== 'transcript' || !event.transcript.trim()) return;

    const key = `${event.channel}:${event.itemId}`;
    const caption = this.upsertTranscriptEvent(key, event);
    this.publish(caption);

    if (event.final) {
      this.cancelProvisional(key);
      void this.normalizeFinal(key, caption);
    } else if (this.settings.provisionalTranslation) {
      this.scheduleProvisional(key, caption);
    }
  }

  upsertTranscriptEvent(key, transcript) {
    const previous = this.eventsByItem.get(key);
    const routedAs = classifyScript(transcript.transcript);
    const fresh = createCaptionEvent({
      sessionId: this.sessionId,
      sequence: previous?.sequence || ++this.sequence,
      sourceChannel: transcript.channel,
      providerItemId: transcript.itemId,
      sourceText: transcript.transcript,
      sourceStartedAt: transcript.startedAt,
      sourceEndedAt: transcript.final ? transcript.at : undefined,
      transcriptStatus: transcript.final ? 'final' : 'provisional',
      profile: this.settings.primaryProfile,
      normalizationModel:
        this.settings.primaryProfile === 'quality'
          ? 'gpt-5.6-luna'
          : 'gpt-5.4-nano',
      fastPath: this.settings.fastPath,
    });
    if (previous) {
      fresh.id = previous.id;
      fresh.sequence = previous.sequence;
      fresh.usage = previous.usage;
      fresh.english.revision =
        fresh.english.status === 'pending'
          ? previous.english.revision
          : previous.english.revision + 1;
      fresh.chinese.revision =
        fresh.chinese.status === 'pending'
          ? previous.chinese.revision
          : previous.chinese.revision + 1;
      if (fresh.english.status === 'pending' && previous.english.status !== 'final') {
        fresh.english = previous.english;
      }
      if (fresh.chinese.status === 'pending' && previous.chinese.status !== 'final') {
        fresh.chinese = previous.chinese;
      }
    }
    fresh.routedAs = routedAs;
    this.eventsByItem.set(key, fresh);
    return fresh;
  }

  scheduleProvisional(key, caption) {
    clearTimeout(this.pendingTimers.get(key));
    this.pendingTimers.set(
      key,
      setTimeout(() => {
        this.pendingTimers.delete(key);
        void this.normalizePrimary(key, caption, false);
      }, 700),
    );
  }

  cancelProvisional(key) {
    clearTimeout(this.pendingTimers.get(key));
    this.pendingTimers.delete(key);
    const controller = this.abortControllers.get(key);
    if (controller) controller.abort();
    this.abortControllers.delete(key);
  }

  async normalizePrimary(key, caption, final) {
    const controller = new AbortController();
    this.abortControllers.set(key, controller);
    const targets =
      final || caption.routedAs === 'mixed' || caption.routedAs === 'unknown'
        ? ['en', 'zh']
        : [caption.routedAs === 'en' ? 'zh' : 'en'];

    await Promise.all(
      targets.map(async (target) => {
        if (!this.cost.canSpend()) return;
        try {
          const result = await this.primaryNormalizer.normalize({
            sourceText: caption.sourceText,
            target,
            profile: this.settings.primaryProfile,
            final,
            glossary: this.settings.glossary,
            signal: controller.signal,
          });
          if (controller.signal.aborted || !this.active) return;
          const current = this.eventsByItem.get(key);
          if (!current || current.sourceText !== caption.sourceText) return;
          const updated = updateTarget(current, target, {
            text: result.text,
            status: final ? 'final' : 'provisional',
            passthrough: false,
          });
          updated.sourceLanguage = result.sourceLanguage;
          updated.provider.normalizationModel = result.model;
          updated.usage = {
            ...updated.usage,
            normalizationTokensIn:
              updated.usage.normalizationTokensIn + result.usage.inputTokens,
            normalizationTokensOut:
              updated.usage.normalizationTokensOut + result.usage.outputTokens,
            normalizationCalls: updated.usage.normalizationCalls + 1,
            estimatedCostUsd: this.cost.snapshot().totalUsd,
          };
          this.eventsByItem.set(key, updated);
          this.publish(updated);
        } catch (error) {
          if (error.name === 'AbortError' || controller.signal.aborted) return;
          const current = this.eventsByItem.get(key);
          if (!current) return;
          const updated = updateTarget(current, target, errorTarget(error));
          this.eventsByItem.set(key, updated);
          this.publish(updated);
          this.onStatus({
            state: 'degraded',
            sessionId: this.sessionId,
            code: error.code || 'normalization_failed',
            message: error.message,
          });
        }
      }),
    );
    if (this.abortControllers.get(key) === controller) {
      this.abortControllers.delete(key);
    }
  }

  async normalizeFinal(key, caption) {
    const startedAt = Date.now();
    await this.normalizePrimary(key, caption, true);
    const primary = this.eventsByItem.get(key);
    if (!primary) return;

    let shadow = null;
    if (this.shadowActive && this.cost.canSpend()) {
      const shadowStartedAt = Date.now();
      try {
        const [english, chinese] = await Promise.all(
          ['en', 'zh'].map((target) =>
            this.shadowNormalizer.normalize({
              sourceText: caption.sourceText,
              target,
              profile: this.settings.shadowProfile,
              final: true,
              glossary: this.settings.glossary,
            }),
          ),
        );
        shadow = {
          profile: this.settings.shadowProfile,
          english: english.text,
          chinese: chinese.text,
          sourceLanguage: english.sourceLanguage,
          latencyMs: Date.now() - shadowStartedAt,
        };
      } catch (error) {
        shadow = { error: error.code || 'shadow_failed' };
      }
    }

    this.onEvaluation({
      sessionId: this.sessionId,
      sequence: primary.sequence,
      sourceChannel: primary.sourceChannel,
      sourceText: primary.sourceText,
      primary: {
        profile: this.settings.primaryProfile,
        english: primary.english.text,
        chinese: primary.chinese.text,
        latencyMs: Date.now() - startedAt,
      },
      shadow,
      metrics: this.cost.snapshot(),
    });
    this.evaluationRecorder?.record('evaluation', {
      sessionId: this.sessionId,
      sequence: primary.sequence,
      sourceChannel: primary.sourceChannel,
      sourceText: primary.sourceText,
      primary: {
        profile: this.settings.primaryProfile,
        english: primary.english.text,
        chinese: primary.chinese.text,
        latencyMs: Date.now() - startedAt,
      },
      shadow,
      metrics: this.cost.snapshot(),
    });
  }

  publish(event) {
    const index = this.history.findIndex((item) => item.id === event.id);
    if (index >= 0) this.history[index] = event;
    else this.history.push(event);
    if (this.history.length > 500) this.history.shift();
    this.onCaption(event);
    this.evaluationRecorder?.record('caption', event);
  }

  async startReplaySequence(recordingId) {
    const records = await this.evaluationRecorder.read(recordingId);
    const replayable = records.filter((record) =>
      ['caption', 'evaluation'].includes(record.kind),
    );
    if (!replayable.length) throw new Error('This recording has no replayable captions');
    const firstAt = replayable[0].at;
    replayable.forEach((record) => {
      const delay = Math.min(12000, Math.max(0, (record.at - firstAt) / 4));
      this.mockTimers.push(
        setTimeout(() => {
          if (!this.active) return;
          if (record.kind === 'caption') this.onCaption(record.payload);
          else this.onEvaluation(record.payload);
        }, delay),
      );
    });
  }

  startMockSequence() {
    const samples = [
      {
        channel: 'microphone',
        source: '这个支架的公差我们需要控制在正负零点二毫米。',
        en: 'We need to hold this bracket tolerance to plus or minus 0.2 millimeters.',
        zh: '这个支架的公差我们需要控制在正负 0.2 毫米。',
      },
      {
        channel: 'system',
        source: 'Can we move the DVT build to the second week of September?',
        en: 'Can we move the DVT build to the second week of September?',
        zh: '我们可以把 DVT 试产移到九月的第二周吗？',
      },
      {
        channel: 'microphone',
        source: '这个 boss 的 wall thickness 现在是 1.2 millimeters，可能太薄。',
        en: 'The wall thickness of this boss is currently 1.2 millimeters and may be too thin.',
        zh: '这个凸台的壁厚目前是 1.2 毫米，可能太薄。',
      },
    ];
    samples.forEach((sample, index) => {
      this.mockTimers.push(
        setTimeout(() => {
          if (!this.active) return;
          const itemId = `mock-${index + 1}`;
          const key = `${sample.channel}:${itemId}`;
          const provisional = this.upsertTranscriptEvent(key, {
            channel: sample.channel,
            itemId,
            transcript: sample.source.slice(0, Math.ceil(sample.source.length * 0.68)),
            final: false,
            startedAt: Date.now(),
            at: Date.now(),
          });
          this.publish(provisional);
        }, index * 2800 + 350),
      );
      this.mockTimers.push(
        setTimeout(() => {
          if (!this.active) return;
          const itemId = `mock-${index + 1}`;
          const key = `${sample.channel}:${itemId}`;
          let finalEvent = this.upsertTranscriptEvent(key, {
            channel: sample.channel,
            itemId,
            transcript: sample.source,
            final: true,
            startedAt: Date.now() - 900,
            at: Date.now(),
          });
          finalEvent = updateTarget(finalEvent, 'en', {
            text: sample.en,
            status: 'final',
            passthrough: classifyScript(sample.source) === 'en',
          });
          finalEvent = updateTarget(finalEvent, 'zh', {
            text: sample.zh,
            status: 'final',
            passthrough: classifyScript(sample.source) === 'zh',
          });
          this.eventsByItem.set(key, finalEvent);
          this.publish(finalEvent);
          this.onEvaluation({
            sessionId: this.sessionId,
            sequence: finalEvent.sequence,
            sourceChannel: sample.channel,
            sourceText: sample.source,
            primary: {
              profile: this.settings.primaryProfile,
              english: sample.en,
              chinese: sample.zh,
              latencyMs: 620 + index * 70,
            },
            shadow: {
              profile: this.settings.shadowProfile,
              english: sample.en,
              chinese: sample.zh,
              sourceLanguage: classifyScript(sample.source),
              latencyMs: 810 + index * 90,
            },
            metrics: this.cost.snapshot(),
          });
        }, index * 2800 + 1500),
      );
    });
  }

  handleBudgetEvent(event) {
    if (event.type === 'exhausted' && this.shadowActive) {
      this.shadowActive = false;
      this.onStatus({
        state: 'degraded',
        sessionId: this.sessionId,
        code: 'shadow_budget_stopped',
        message: 'The comparison pipeline stopped at the session budget cap',
      });
      return;
    }
    this.onStatus({
      state: 'budget-warning',
      sessionId: this.sessionId,
      message: 'Session spend has reached 75% of the configured cap',
    });
  }

  emitMetrics() {
    this.onMetrics({
      sessionId: this.sessionId,
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
      ...this.cost.snapshot(),
    });
  }

  async stop() {
    if (!this.active) return this.snapshot();
    this.active = false;
    for (const timer of this.pendingTimers.values()) clearTimeout(timer);
    for (const timer of this.mockTimers) clearTimeout(timer);
    for (const controller of this.abortControllers.values()) controller.abort();
    this.pendingTimers.clear();
    this.mockTimers = [];
    this.abortControllers.clear();
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    await this.evaluationRecorder?.stop();
    this.onStatus({
      state: 'stopped',
      sessionId: this.sessionId,
      metrics: this.cost?.snapshot(),
    });
    return this.snapshot();
  }

  snapshot() {
    return {
      active: this.active,
      sessionId: this.sessionId,
      settings: this.settings,
      metrics: this.cost?.snapshot() || null,
      captionCount: this.history.length,
      shadowActive: this.shadowActive,
    };
  }

  export(format = 'json') {
    if (format === 'markdown') {
      const body = this.history
        .filter((event) => event.status === 'final')
        .sort((a, b) => a.sequence - b.sequence)
        .map(
          (event) =>
            `### ${event.sequence}. ${event.sourceChannel}\n\n` +
            `Source: ${event.sourceText}\n\n` +
            `English: ${event.english.text || 'Translation unavailable'}\n\n` +
            `中文: ${event.chinese.text || '翻译不可用'}`,
        )
        .join('\n\n');
      return `# Bilingual caption session\n\nSession: ${this.sessionId}\n\n${body}\n`;
    }
    return JSON.stringify(
      {
        version: 1,
        sessionId: this.sessionId,
        settings: this.settings,
        metrics: this.cost?.snapshot(),
        captions: this.history,
      },
      null,
      2,
    );
  }
}

module.exports = { CaptionSessionManager, errorTarget };
