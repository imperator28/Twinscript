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
const { resolveProcessingConfiguration } = require('./processing-configuration');
const {
  compileGlossaryRequestContext,
} = require('./glossary-request-context');
const { PriorityTaskQueue } = require('./priority-task-queue');
const { buildQualitySignals } = require('./quality-signals');
const { TranscriptCoordinator } = require('./transcript-coordinator');
const { createTranslationPolicy } = require('./translation-policy');
const { TranscriptionBackendFactory } = require('./transcription-backends');
const { TranslationBackendFactory } = require('./translation-backends');

const PROVISIONAL_INITIAL_DELAY_MS = 650;
const PROVISIONAL_CADENCE_MS = 1800;
const MAX_PROVISIONAL_CALLS_PER_ITEM = 8;

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

function sanitizeScreeningPrompt(prompt) {
  if (!prompt) return null;
  const value = {
    id: String(prompt.id || '').trim().slice(0, 120),
    sourceChannel: prompt.sourceChannel,
    languageClass: String(prompt.languageClass || '').trim().slice(0, 40),
    condition: String(prompt.condition || '').trim().slice(0, 160),
    sourceText: String(prompt.sourceText || '').trim().slice(0, 1000),
    englishReference: String(prompt.englishReference || '').trim().slice(0, 1000),
    chineseReference: String(prompt.chineseReference || '').trim().slice(0, 1000),
    protectedTokens: Array.isArray(prompt.protectedTokens)
      ? prompt.protectedTokens
          .map((token) => String(token || '').trim().slice(0, 120))
          .filter(Boolean)
          .slice(0, 20)
      : [],
    critical: Boolean(prompt.critical),
    scripted: true,
  };
  if (
    !value.id ||
    !['microphone', 'system'].includes(value.sourceChannel) ||
    !['en', 'zh', 'mixed-between', 'mixed-inline'].includes(value.languageClass) ||
    !value.sourceText ||
    !value.englishReference ||
    !value.chineseReference
  ) {
    throw new Error('Invalid screening prompt');
  }
  return value;
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
    transcriptionBackendFactory,
    translationBackendFactory,
    evaluationRecorder,
    meetingRecordController,
    localInferenceSupervisor,
    appVersion,
    coordinatorFactory,
    schedulerFactory,
    transcriptionDrainTimeoutMs = 12_000,
    finalizationDrainTimeoutMs = 30_000,
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
    this.transcriptionBackendFactory = transcriptionBackendFactory || (
      transcriptionFactory
        ? { create: (_model, options) => this.transcriptionFactory(options) }
        : new TranscriptionBackendFactory()
    );
    this.translationBackendFactory = translationBackendFactory || (
      normalizerFactory
        ? { create: (_model, options) => this.normalizerFactory(options) }
        : new TranslationBackendFactory()
    );
    this.evaluationRecorder = evaluationRecorder;
    this.meetingRecordController = meetingRecordController;
    this.localInferenceSupervisor = localInferenceSupervisor;
    this.appVersion = appVersion;
    this.coordinatorFactory =
      coordinatorFactory || ((options) => new TranscriptCoordinator(options));
    this.schedulerFactory =
      schedulerFactory || ((options) => new PriorityTaskQueue(options));
    this.transcriptionDrainTimeoutMs = transcriptionDrainTimeoutMs;
    this.finalizationDrainTimeoutMs = finalizationDrainTimeoutMs;
    this.reset();
  }

  reset() {
    this.coordinator?.reset();
    this.sessionId = null;
    this.mode = null;
    this.settings = null;
    this.sessions = new Map();
    this.eventsByItem = new Map();
    this.history = [];
    this.sequence = 0;
    this.pendingTimers = new Map();
    this.abortControllers = new Map();
    this.lastProvisionalAtByItem = new Map();
    this.shadowControllers = new Set();
    this.primaryNormalizer = null;
    this.previewTranslator = null;
    this.finalTranslator = null;
    this.shadowNormalizer = null;
    this.processing = null;
    this.translationPolicy = null;
    this.localClient = null;
    this.cost = null;
    this.active = false;
    this.shadowActive = false;
    this.mockTimers = [];
    this.startedAt = null;
    this.coordinator = null;
    this.diagnostics = {
      duplicateCandidates: 0,
      suppressedDuplicates: 0,
      droppedAudioMs: { microphone: 0, system: 0 },
      reconnects: { microphone: 0, system: 0 },
      providerErrors: 0,
    };
    this.lastMetrics = null;
    this.normalizationScheduler = null;
    this.evaluationHistory = [];
    this.evaluationRatings = new Map();
    this.screeningPrompt = null;
    this.screeningPromptByItem = new Map();
    this.provisionalCallsByItem = new Map();
    this.lastMetricsRecordedAt = 0;
    this.meetingRecord = null;
    this.recordedFinalKeys = new Set();
    this.normalizationContextMetrics = {
      requests: 0,
      totalGlossaryRows: 0,
      totalPromptCharacters: 0,
      lastGlossaryRows: 0,
      lastPromptCharacters: 0,
    };
    this.pendingFinalizations = new Set();
    this.finalizingStop = false;
  }

  async start(request = {}) {
    if (this.active) await this.stop();
    this.reset();
    this.sessionId = crypto.randomUUID();
    this.mode = request.mode || 'live';
    // The store's return value is what the session runs on.
    //
    // This used to call set() and throw the result away, keeping the renderer's raw object.
    // Every validation the store performs - clamping, enum checks, the delay profile - was
    // therefore applied to the file on disk and NOT to the settings this session sends to
    // the API. A bad value was corrected everywhere except the one place it mattered.
    const requested = {
      ...this.settingsStore.get(),
      ...(request.settings || {}),
    };
    const stored = this.settingsStore.set(requested);
    // Falls back to the requested object if the store returns nothing. Depending on a
    // return value would make a store that legitimately returns void crash the session,
    // and a session that cannot start is a worse failure than one running unnormalized
    // settings.
    this.settings = stored && typeof stored === 'object' ? stored : requested;
    this.processing = resolveProcessingConfiguration(this.settings);
    this.translationPolicy = createTranslationPolicy(this.settings);
    this.startedAt = Date.now();
    this.active = true;
    this.shadowActive = Boolean(this.settings.shadowEnabled);
    this.cost = new CostMeter({
      budgetUsd: this.settings.budgetUsd,
      onBudgetEvent: (event) => this.handleBudgetEvent(event),
    });
    this.coordinator = this.coordinatorFactory({
      reorderWindowMs: this.settings.reorderWindowMs || 400,
      duplicateWindowMs: this.settings.duplicateWindowMs || 1400,
      onRelease: (event) => this.releaseFinalTranscript(event),
      onDuplicate: (candidate) => this.handleDuplicate(candidate),
    });
    this.normalizationScheduler = this.schedulerFactory({
      concurrency: 2,
      maxQueue: 24,
    });
    this.screeningPrompt = sanitizeScreeningPrompt(request.screeningPrompt);

    this.onStatus({
      state: 'starting',
      sessionId: this.sessionId,
      mode: this.mode,
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
      try {
        await this.startReplaySequence(request.recordingId);
        return this.snapshot();
      } catch (error) {
        await this.stop('replay-failed');
        throw error;
      }
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

    let apiKey = null;
    if (this.processing.requiresCredential) {
      apiKey = await this.credentialStore.get();
      if (!apiKey) {
        this.active = false;
        throw new Error('Add an OpenAI API key before starting a live session');
      }
    }

    const localModels = new Set();
    if (this.processing.transcription === 'whisper-local') {
      localModels.add('whisper-small');
    }
    if (
      this.translationPolicy.finalBackend === 'hy-mt2-local' ||
      this.translationPolicy.previewBackend === 'hy-mt2-local'
    ) {
      localModels.add('hy-mt2-1.8b');
    }
    if (localModels.size) {
      try {
        await this.localInferenceSupervisor.prepare([...localModels], this.sessionId);
        this.localClient = this.localInferenceSupervisor.client();
      } catch (error) {
        this.active = false;
        throw error;
      }
    }

    try {
      this.meetingRecord = await this.meetingRecordController?.startSession({
        sessionId: this.sessionId,
        startedAt: this.startedAt,
        settings: this.settings,
      });
    } catch (error) {
      this.active = false;
      throw error;
    }

    const glossaryKeywords = [
      ...(this.settings.protectedTokens || []),
      ...(this.settings.glossary || []).flatMap((entry) => [
        entry.en,
        entry.zh,
        ...(entry.aliases || []),
      ]),
    ];
    const cloudNormalizerOptions = {
      apiKey,
      scheduler: this.normalizationScheduler,
    };
    const finalOptions = this.translationPolicy.finalBackend === 'hy-mt2-local'
      ? { client: this.localClient, sessionId: this.sessionId }
      : {
          ...cloudNormalizerOptions,
          onUsage: (usage) => {
            this.cost.addTextUsage(usage, 'primary');
            this.emitMetrics();
          },
        };
    this.finalTranslator = this.translationBackendFactory.create(
      this.translationPolicy.finalBackend,
      finalOptions,
    );
    this.primaryNormalizer = this.finalTranslator;
    if (!this.translationPolicy.previewBackend) {
      this.previewTranslator = null;
    } else if (this.translationPolicy.previewBackend === this.translationPolicy.finalBackend) {
      this.previewTranslator = this.finalTranslator;
    } else {
      this.previewTranslator = this.translationBackendFactory.create(
        this.translationPolicy.previewBackend,
        this.translationPolicy.previewBackend === 'hy-mt2-local'
          ? { client: this.localClient, sessionId: this.sessionId }
          : {
              ...cloudNormalizerOptions,
              onUsage: (usage) => {
                this.cost.addTextUsage(usage, 'primary');
                this.emitMetrics();
              },
            },
      );
    }
    this.shadowActive = Boolean(this.shadowActive && apiKey);
    this.shadowNormalizer = this.shadowActive ? this.normalizerFactory({
      ...cloudNormalizerOptions,
      onUsage: (usage) => {
        this.cost.addTextUsage(usage, 'shadow');
        this.emitMetrics();
      },
    }) : null;

    for (const channel of ['microphone', 'system']) {
      const session = this.transcriptionBackendFactory.create(
        this.processing.transcription,
        {
        channel,
        apiKey,
        client: this.localClient,
        sessionId: this.sessionId,
        settings: this.settings,
        keywords: glossaryKeywords,
        onUsage: ({ audioMs }) => {
          if (this.processing.transcription === 'openai-live') {
            this.cost.addAudio(audioMs);
            this.emitMetrics();
          }
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

  appendAudio({ channel, samples, capturedAt }) {
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
    session.appendAudio(pcm, Number.isFinite(capturedAt) ? capturedAt : Date.now());
    this.meetingRecordController?.writeAudioChunk(
      channel,
      pcm,
      Number.isFinite(capturedAt) ? capturedAt : Date.now(),
      (pcm.length / 24000) * 1000,
    );
  }

  handleTranscriptionEvent(event) {
    if (!this.active && !this.finalizingStop) return;
    this.evaluationRecorder?.record('provider-event', event);
    if (event.type === 'level') {
      this.emitMetrics({
        levels: { [event.channel]: event.rms },
        speaking: { [event.channel]: event.speaking },
      });
      return;
    }
    if (event.type === 'transport-metric') {
      this.diagnostics.droppedAudioMs[event.channel] =
        event.droppedAudioMs || 0;
      this.emitMetrics({
        transport: {
          [event.channel]: {
            sentAudioMs: event.sentAudioMs || 0,
            droppedAudioMs: event.droppedAudioMs || 0,
            pendingChunks: event.pendingChunks || 0,
            bufferedBytes: event.bufferedBytes || 0,
            dropReason: event.dropReason,
          },
        },
      });
      return;
    }
    if (event.type === 'connection' || event.type === 'error') {
      if (event.type === 'error') this.diagnostics.providerErrors += 1;
      if (event.status === 'disconnected') {
        this.diagnostics.reconnects[event.channel] += 1;
      }
      const unhealthy =
        event.type === 'error' || event.status === 'disconnected';
      this.onStatus({
        // Connection events describe one transport, not the whole session.
        // Keep the public lifecycle stable so the renderer never drops its
        // End Session control while a channel reconnects.
        state: unhealthy ? 'degraded' : 'running',
        sessionId: this.sessionId,
        channel: event.channel,
        code: event.code,
        message: event.message,
      });
      return;
    }
    if (event.type !== 'transcript' || !event.transcript.trim()) return;

    if (event.final) {
      const key = `${event.channel}:${event.itemId}`;
      this.cancelProvisional(key);
      if (this.screeningPrompt) {
        this.screeningPromptByItem.set(key, this.screeningPrompt);
      }
      this.coordinator.submit(event);
      return;
    }

    const key = `${event.channel}:${event.itemId}`;
    const caption = this.upsertTranscriptEvent(key, event, false);
    this.publish(caption);
    if (this.settings.provisionalTranslation) {
      this.scheduleProvisional(key);
    }
  }

  upsertTranscriptEvent(
    key,
    transcript,
    assignFinalSequence = Boolean(transcript.final),
  ) {
    const previous = this.eventsByItem.get(key);
    const routedAs = classifyScript(transcript.transcript);
    const fresh = createCaptionEvent({
      sessionId: this.sessionId,
      sequence: assignFinalSequence
        ? ++this.sequence
        : previous?.sequence || this.sequence + 1,
      sourceChannel: transcript.channel,
      providerItemId: transcript.itemId,
      sourceText: transcript.transcript,
      sourceStartedAt: transcript.startedAt,
      sourceEndedAt: transcript.final ? transcript.at : undefined,
      observedAt: transcript.at,
      transcriptStatus: transcript.final ? 'final' : 'provisional',
      profile: this.settings.primaryProfile,
      transcriptionModel: transcript.model || (
        this.processing?.transcription === 'whisper-local'
          ? 'whisper-small'
          : 'gpt-live-transcribe'
      ),
      transcriptionRuntime: transcript.runtime || (
        this.processing?.transcription === 'whisper-local'
          ? 'openvino-genai'
          : 'openai-realtime'
      ),
      transcriptionDevice: transcript.actualDevice || 'cloud',
      normalizationModel:
        this.translationPolicy?.finalBackend === 'hy-mt2-local'
          ? 'hy-mt2-1.8b'
          : this.settings.primaryProfile === 'quality'
            ? 'gpt-5.6-luna'
            : 'gpt-5.4-nano',
      fastPath: this.settings.fastPath,
    });
    if (previous) {
      fresh.id = previous.id;
      fresh.sequence = assignFinalSequence ? fresh.sequence : previous.sequence;
      fresh.usage = previous.usage;
      fresh.firstTranscriptAt = previous.firstTranscriptAt;
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
    if (transcript.final) fresh.releasedAt = Date.now();
    this.eventsByItem.set(key, fresh);
    return fresh;
  }

  releaseFinalTranscript(transcript) {
    if (!this.active && !this.finalizingStop) return;
    const key = `${transcript.channel}:${transcript.itemId}`;
    const caption = this.upsertTranscriptEvent(key, transcript, true);
    this.publish(caption);
    const finalization = this.normalizeFinal(key, caption);
    this.pendingFinalizations.add(finalization);
    void finalization.then(
      () => this.pendingFinalizations.delete(finalization),
      () => this.pendingFinalizations.delete(finalization),
    );
  }

  handleDuplicate({ event, duplicateOf, similarity }) {
    if (!this.active && !this.finalizingStop) return;
    this.diagnostics.duplicateCandidates += 1;
    const suppress = event.channel === 'microphone' ? event : duplicateOf;
    const keep = event.channel === 'system' ? event : duplicateOf;
    const suppressKey = `${suppress.channel}:${suppress.itemId}`;
    const existing = this.eventsByItem.get(suppressKey);
    if (existing) {
      const suppressed = {
        ...existing,
        suppressed: true,
        suppressionReason: 'cross-channel-duplicate',
        duplicateSimilarity: similarity,
      };
      this.eventsByItem.set(suppressKey, suppressed);
      this.cancelProvisional(suppressKey);
      this.publish(suppressed);
    }
    this.diagnostics.suppressedDuplicates += 1;
    this.evaluationRecorder?.record('duplicate', {
      suppressedChannel: suppress.channel,
      keptChannel: keep.channel,
      similarity,
      suppressedItemId: suppress.itemId,
      keptItemId: keep.itemId,
    });
    this.emitMetrics();
    if (event.channel === 'system') {
      this.releaseFinalTranscript(event);
      return event;
    }
    return duplicateOf;
  }

  scheduleProvisional(key) {
    // Do not debounce forever while transcript deltas are continuously
    // arriving. Keep one bounded timer and translate the newest available
    // prefix when it fires.
    if (this.pendingTimers.has(key)) return;
    const calls = this.provisionalCallsByItem.get(key) || 0;
    if (calls >= MAX_PROVISIONAL_CALLS_PER_ITEM) return;
    const lastAt = this.lastProvisionalAtByItem.get(key) || 0;
    const delay = lastAt
      ? Math.max(
          PROVISIONAL_INITIAL_DELAY_MS,
          PROVISIONAL_CADENCE_MS - (Date.now() - lastAt),
        )
      : PROVISIONAL_INITIAL_DELAY_MS;
    this.pendingTimers.set(
      key,
      setTimeout(() => {
        this.pendingTimers.delete(key);
        const current = this.eventsByItem.get(key);
        if (!current || current.finalTranscriptAt) return;
        if (this.abortControllers.has(key)) {
          this.scheduleProvisional(key);
          return;
        }
        const currentCalls = this.provisionalCallsByItem.get(key) || 0;
        if (currentCalls >= MAX_PROVISIONAL_CALLS_PER_ITEM) return;
        this.provisionalCallsByItem.set(key, currentCalls + 1);
        this.lastProvisionalAtByItem.set(key, Date.now());
        void this.normalizePrimary(key, current, false);
      }, delay),
    );
  }

  cancelProvisional(key) {
    clearTimeout(this.pendingTimers.get(key));
    this.pendingTimers.delete(key);
    this.provisionalCallsByItem.delete(key);
    this.lastProvisionalAtByItem.delete(key);
    const controller = this.abortControllers.get(key);
    if (controller) controller.abort();
    this.abortControllers.delete(key);
  }

  async normalizePrimary(key, caption, final) {
    const translator = final
      ? this.finalTranslator || this.primaryNormalizer
      : this.previewTranslator || this.primaryNormalizer;
    if (!translator) return;
    const controller = new AbortController();
    this.abortControllers.set(key, controller);
    const targets =
      final || caption.routedAs === 'mixed' || caption.routedAs === 'unknown'
        ? ['en', 'zh']
        : [caption.routedAs === 'en' ? 'zh' : 'en'];
    const requestContext = compileGlossaryRequestContext({
      sourceText: caption.sourceText,
      glossary: this.settings.glossary,
      customTerms: this.settings.customGlossaryConfiguration?.terms,
      protectedTokens: this.settings.protectedTokens,
    });

    await Promise.all(
      targets.map(async (target) => {
        if (!this.cost.canSpend()) return;
        try {
          this.recordNormalizationContext(requestContext.metrics);
          const result = await translator.normalize({
            sourceText: caption.sourceText,
            sourceLanguage: caption.sourceLanguage,
            target,
            profile: this.settings.primaryProfile,
            final,
            glossary: requestContext.glossary,
            protectedTokens: requestContext.protectedTokens,
            signal: controller.signal,
            priority: final ? 10 : 0,
            utteranceId: key,
            sourceRevision: Math.max(
              caption.english?.revision || 0,
              caption.chinese?.revision || 0,
            ),
          });
          if (
            controller.signal.aborted ||
            (!this.active && !this.finalizingStop)
          ) {
            return;
          }
          const current = this.eventsByItem.get(key);
          if (!current || (final && current.sourceText !== caption.sourceText)) {
            return;
          }
          const updated = updateTarget(current, target, {
            text: result.text,
            status: final ? 'final' : 'provisional',
            passthrough: false,
          });
          updated.sourceLanguage = result.sourceLanguage;
          updated.provider.normalizationModel = result.model;
          updated.provider.normalizationRuntime = result.runtime || 'openai-responses';
          updated.provider.normalizationDevice = result.actualDevice || 'cloud';
          if (final) {
            updated.provider.finalNormalizationModel = result.model;
            updated.provider.finalNormalizationRuntime = result.runtime || 'openai-responses';
            updated.provider.finalNormalizationDevice = result.actualDevice || 'cloud';
          }
          updated.usage = {
            ...updated.usage,
            normalizationTokensIn:
              updated.usage.normalizationTokensIn + (result.usage?.inputTokens || 0),
            normalizationTokensOut:
              updated.usage.normalizationTokensOut + (result.usage?.outputTokens || 0),
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
    if (
      !primary.suppressed &&
      !this.recordedFinalKeys.has(key) &&
      ['final', 'failed'].includes(primary.status)
    ) {
      this.recordedFinalKeys.add(key);
      this.meetingRecordController?.appendFinalRecord(primary);
    }

    let shadow = null;
    if (this.shadowActive && this.cost.canSpend()) {
      const shadowStartedAt = Date.now();
      const shadowController = new AbortController();
      this.shadowControllers.add(shadowController);
      try {
        const requestContext = compileGlossaryRequestContext({
          sourceText: caption.sourceText,
          glossary: this.settings.glossary,
          customTerms: this.settings.customGlossaryConfiguration?.terms,
          protectedTokens: this.settings.protectedTokens,
        });
        const [english, chinese] = await Promise.all(
          ['en', 'zh'].map((target) => {
            this.recordNormalizationContext(requestContext.metrics);
            return this.shadowNormalizer.normalize({
              sourceText: caption.sourceText,
              target,
              profile: this.settings.shadowProfile,
              final: true,
              glossary: requestContext.glossary,
              protectedTokens: requestContext.protectedTokens,
              priority: 2,
              signal: shadowController.signal,
            });
          }),
        );
        shadow = {
          profile: this.settings.shadowProfile,
          english: english.text,
          chinese: chinese.text,
          sourceLanguage: english.sourceLanguage,
          latencyMs: Date.now() - shadowStartedAt,
        };
      } catch (error) {
        shadow = {
          error:
            error.name === 'AbortError'
              ? 'shadow_aborted'
              : error.code || 'shadow_failed',
        };
      } finally {
        this.shadowControllers.delete(shadowController);
      }
    }

    const completedAt = Date.now();
    const evaluation = {
      sessionId: this.sessionId,
      sequence: primary.sequence,
      sourceChannel: primary.sourceChannel,
      sourceText: primary.sourceText,
      screeningPrompt: this.screeningPromptByItem.get(key) || null,
      primary: {
        profile: this.settings.primaryProfile,
        english: primary.english.text,
        chinese: primary.chinese.text,
        latencyMs: completedAt - startedAt,
      },
      shadow,
      metrics: this.cost.snapshot(),
      stageLatency: {
        transcriptionMs: Math.max(
          0,
          (primary.finalTranscriptAt || completedAt) - primary.sourceStartedAt,
        ),
        reorderMs: Math.max(
          0,
          (primary.releasedAt || completedAt) -
            (primary.finalTranscriptAt || completedAt),
        ),
        normalizationMs: completedAt - startedAt,
        firstEnglishMs: primary.english.firstRenderedAt
          ? primary.english.firstRenderedAt - primary.sourceStartedAt
          : null,
        firstChineseMs: primary.chinese.firstRenderedAt
          ? primary.chinese.firstRenderedAt - primary.sourceStartedAt
          : null,
        endToEndMs: Math.max(0, completedAt - primary.sourceStartedAt),
      },
      signals: buildQualitySignals({
        sourceText: primary.sourceText,
        english: primary.english.text,
        chinese: primary.chinese.text,
        fastPath: this.settings.fastPath,
      }),
    };
    this.evaluationHistory.push(evaluation);
    if (this.evaluationHistory.length > 500) this.evaluationHistory.shift();
    this.onEvaluation(evaluation);
    this.evaluationRecorder?.record('evaluation', evaluation);
  }

  setScreeningPrompt(prompt) {
    this.screeningPrompt = sanitizeScreeningPrompt(prompt);
    this.evaluationRecorder?.record('screening-prompt', this.screeningPrompt);
    return this.screeningPrompt;
  }

  rateEvaluation({
    sequence,
    preference,
    semanticScore = null,
    flags = [],
    notes = '',
  }) {
    if (!Number.isInteger(sequence) || sequence < 1) {
      throw new Error('Invalid evaluation sequence');
    }
    if (!['primary', 'shadow', 'tie', 'skip'].includes(preference)) {
      throw new Error('Invalid comparison preference');
    }
    const cleanScore =
      semanticScore === null || semanticScore === undefined
        ? null
        : Number(semanticScore);
    if (
      cleanScore !== null &&
      (!Number.isInteger(cleanScore) || cleanScore < 1 || cleanScore > 5)
    ) {
      throw new Error('Semantic score must be between 1 and 5');
    }
    const allowedFlags = new Set([
      'wrong-language',
      'omission',
      'hallucination',
      'number-unit-id',
      'terminology',
      'late',
      'flutter',
      'duplicate',
    ]);
    const cleanFlags = Array.isArray(flags)
      ? [...new Set(flags.filter((flag) => allowedFlags.has(flag)))]
      : [];
    const rating = {
      sequence,
      preference,
      semanticScore: cleanScore,
      flags: cleanFlags,
      notes: String(notes || '').trim().slice(0, 500),
      ratedAt: Date.now(),
    };
    this.evaluationRatings.set(sequence, rating);
    this.evaluationRecorder?.record('rating', rating);
    return rating;
  }

  abortShadow() {
    this.shadowActive = false;
    for (const controller of this.shadowControllers) controller.abort();
    this.shadowControllers.clear();
    this.onStatus({
      state: 'running',
      sessionId: this.sessionId,
      code: 'shadow_aborted',
      message: 'Shadow comparison stopped; primary captions continue',
    });
    return this.snapshot();
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
      ['caption', 'evaluation', 'metrics'].includes(record.kind),
    );
    if (!replayable.length) throw new Error('This recording has no replayable captions');
    const firstAt = replayable[0].at;
    let finalDelay = 0;
    replayable.forEach((record) => {
      const delay = Math.min(12000, Math.max(0, (record.at - firstAt) / 4));
      finalDelay = Math.max(finalDelay, delay);
      this.mockTimers.push(
        setTimeout(() => {
          if (!this.active) return;
          if (record.kind === 'caption') this.publish(record.payload);
          else if (record.kind === 'metrics') this.onMetrics(record.payload);
          else {
            this.evaluationHistory.push(record.payload);
            this.onEvaluation(record.payload);
          }
        }, delay),
      );
    });
    this.mockTimers.push(
      setTimeout(() => {
        if (this.active) void this.stop('replay-complete');
      }, finalDelay + 500),
    );
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
          const evaluation = {
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
            stageLatency: {
              transcriptionMs: 900,
              reorderMs: 0,
              normalizationMs: 620 + index * 70,
              firstEnglishMs: 1520 + index * 70,
              firstChineseMs: 1520 + index * 70,
              endToEndMs: 1520 + index * 70,
            },
            signals: buildQualitySignals({
              sourceText: sample.source,
              english: sample.en,
              chinese: sample.zh,
              fastPath: this.settings.fastPath,
            }),
          };
          this.evaluationHistory.push(evaluation);
          this.onEvaluation(evaluation);
        }, index * 2800 + 1500),
      );
    });
  }

  handleBudgetEvent(event) {
    if (event.type === 'exhausted') {
      const shadowWasActive = this.shadowActive;
      this.shadowActive = false;
      this.onStatus({
        state: 'budget-exhausted',
        sessionId: this.sessionId,
        code: shadowWasActive
          ? 'shadow_and_session_budget_stopped'
          : 'session_budget_stopped',
        message:
          'The session stopped at the configured spend cap; no more audio will be submitted',
      });
      queueMicrotask(() => void this.stop('budget-exhausted'));
      return;
    }
    this.onStatus({
      state: 'budget-warning',
      sessionId: this.sessionId,
      message: 'Session spend has reached 75% of the configured cap',
    });
  }

  /**
   * Apply a settings change to the session already running.
   *
   * Most settings are snapshotted at start() and cannot change mid-session - the
   * transcription delay, for instance, is sent once in the session.update that opens the
   * socket. The budget is the exception, because the whole point of the mid-meeting "+$2"
   * control is to lift a cap while the meeting is still going. It previously only wrote the
   * stored setting, so the running meter kept the old cap and a stopped session stayed
   * stopped.
   */
  applyLiveSettings(patch = {}) {
    if (!this.active || !this.cost) return null;
    if (!Object.hasOwn(patch, 'budgetUsd')) return null;
    this.settings = { ...this.settings, budgetUsd: patch.budgetUsd };
    this.cost.setBudget(patch.budgetUsd);
    // Pushed immediately so the live bar redraws against the new cap rather than waiting
    // for the next transcription event, which may be a while on a quiet line.
    this.emitMetrics();
    return this.cost.snapshot();
  }

  emitMetrics(extra = {}) {
    const next = {
      sessionId: this.sessionId,
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
      ...this.cost.snapshot(),
      diagnostics: this.diagnostics,
      normalizationQueue: this.normalizationScheduler?.snapshot() || {
        running: 0,
        queued: 0,
      },
      ...extra,
    };
    this.lastMetrics = {
      ...(this.lastMetrics || {}),
      ...next,
      levels: {
        ...(this.lastMetrics?.levels || {}),
        ...(next.levels || {}),
      },
      speaking: {
        ...(this.lastMetrics?.speaking || {}),
        ...(next.speaking || {}),
      },
      transport: {
        ...(this.lastMetrics?.transport || {}),
        ...(next.transport || {}),
      },
    };
    this.onMetrics(this.lastMetrics);
    const now = Date.now();
    if (now - this.lastMetricsRecordedAt >= 500 || extra.transport) {
      this.lastMetricsRecordedAt = now;
      this.evaluationRecorder?.record('metrics', this.lastMetrics);
    }
  }

  recordNormalizationContext({ glossaryRows, promptCharacters }) {
    const current = this.normalizationContextMetrics;
    current.requests += 1;
    current.totalGlossaryRows += glossaryRows;
    current.totalPromptCharacters += promptCharacters;
    current.lastGlossaryRows = glossaryRows;
    current.lastPromptCharacters = promptCharacters;
    this.emitMetrics({ normalizationContext: { ...current } });
  }

  async stop(reason = 'user') {
    if (!this.active) return this.snapshot();
    this.active = false;
    this.finalizingStop = true;
    for (const timer of this.pendingTimers.values()) clearTimeout(timer);
    for (const timer of this.mockTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    this.mockTimers = [];
    this.provisionalCallsByItem.clear();
    this.screeningPromptByItem.clear();
    const sessions = [...this.sessions.values()];
    const drainingTranscription = Promise.allSettled(
      sessions.map((session) =>
        typeof session.finish === 'function'
          ? session.finish()
          : Promise.resolve(session.close()),
      ),
    );
    let transcriptionTimer;
    const transcriptionTimedOut = await Promise.race([
      drainingTranscription.then(() => false),
      new Promise((resolve) => {
        transcriptionTimer = setTimeout(() => resolve(true), this.transcriptionDrainTimeoutMs);
        transcriptionTimer.unref?.();
      }),
    ]);
    clearTimeout(transcriptionTimer);
    if (transcriptionTimedOut) {
      for (const session of sessions) session.cancelPending?.();
      this.onStatus({
        state: 'degraded',
        sessionId: this.sessionId,
        code: 'transcription_shutdown_timeout',
        message: 'Transcription did not finish before the bounded shutdown timeout',
      });
    }
    this.sessions.clear();
    this.coordinator?.flush();
    // Emit any sentence still waiting for a continuation before tearing down. The
    // speaker has stopped, so a trailing fragment is the last thing they said and
    // discarding it would silently lose the end of the meeting.
    this.coordinator?.flushHeld();
    this.coordinator?.reset();
    const pendingFinalizations = Promise.allSettled([...this.pendingFinalizations]);
    let drainTimer;
    const drainTimedOut = await Promise.race([
      pendingFinalizations.then(() => false),
      new Promise((resolve) => {
        drainTimer = setTimeout(() => resolve(true), this.finalizationDrainTimeoutMs);
        drainTimer.unref?.();
      }),
    ]);
    clearTimeout(drainTimer);
    if (drainTimedOut) {
      for (const controller of this.abortControllers.values()) controller.abort();
      for (const controller of this.shadowControllers) controller.abort();
      this.onStatus({
        state: 'degraded',
        sessionId: this.sessionId,
        code: 'translation_shutdown_timeout',
        message: 'Translation did not finish before the bounded shutdown timeout',
      });
    }
    this.finalizingStop = false;
    for (const controller of this.abortControllers.values()) controller.abort();
    for (const controller of this.shadowControllers) controller.abort();
    this.abortControllers.clear();
    this.shadowControllers.clear();
    await this.evaluationRecorder?.stop();
    if (this.mode === 'live' && this.meetingRecordController) {
      this.meetingRecord = await this.meetingRecordController.stopSession({
        appVersion: this.appVersion,
        estimatedCostUsd: this.cost?.snapshot().totalUsd,
      });
    }
    this.onStatus({
      state: 'stopped',
      sessionId: this.sessionId,
      metrics: this.cost?.snapshot(),
      reason,
      meetingRecord: this.meetingRecord,
    });
    return this.snapshot();
  }

  snapshot() {
    return {
      active: this.active,
      sessionId: this.sessionId,
      settings: this.settings,
      metrics: this.cost?.snapshot() || null,
      diagnostics: this.diagnostics,
      captionCount: this.history.length,
      shadowActive: this.shadowActive,
      evaluationCount: this.evaluationHistory.length,
      ratingCount: this.evaluationRatings.size,
      meetingRecord: this.meetingRecord,
    };
  }

  export(format = 'json') {
    if (format === 'markdown') {
      const body = this.history
        .filter((event) => event.status === 'final' && !event.suppressed)
        .sort((a, b) => a.sequence - b.sequence)
        .map(
          (event) =>
            `### ${event.sequence}. ${event.sourceChannel}\n\n` +
            `Source: ${event.sourceText}\n\n` +
            `English: ${event.english.text || 'Translation unavailable'}\n\n` +
            `中文: ${event.chinese.text || '翻译不可用'}`,
        )
        .join('\n\n');
      const ratings = [...this.evaluationRatings.values()];
      const counts = ratings.reduce((summary, rating) => {
        summary[rating.preference] = (summary[rating.preference] || 0) + 1;
        return summary;
      }, {});
      const review = this.evaluationHistory
        .map((evaluation) => {
          const rating = this.evaluationRatings.get(evaluation.sequence);
          return (
            `### Review ${evaluation.sequence}` +
            `${evaluation.screeningPrompt ? ` · ${evaluation.screeningPrompt.id}` : ''}\n\n` +
            `Primary: ${evaluation.primary.profile}\n\n` +
            `Shadow: ${
              evaluation.shadow && !evaluation.shadow.error
                ? evaluation.shadow.profile
                : 'Unavailable'
            }\n\n` +
            `Preference: ${rating?.preference || 'Unrated'}\n\n` +
            `Semantic score: ${rating?.semanticScore || 'Not scored'}\n\n` +
            `Flags: ${rating?.flags?.join(', ') || 'None'}\n\n` +
            `Notes: ${rating?.notes || 'None'}`
          );
        })
        .join('\n\n');
      return (
        `# Twinscript caption session\n\nSession: ${this.sessionId}\n\n` +
        `Estimated cost: $${(this.cost?.snapshot().totalUsd || 0).toFixed(4)}\n\n` +
        `A/B ratings: ${JSON.stringify(counts)}\n\n${body}\n\n` +
        `## Blinded review evidence\n\n${review || 'No review evidence.'}\n`
      );
    }
    return JSON.stringify(
      {
        version: 1,
        sessionId: this.sessionId,
        settings: this.settings,
        metrics: {
          ...this.cost?.snapshot(),
          diagnostics: this.diagnostics,
        },
        captions: this.history,
        evaluations: this.evaluationHistory,
        ratings: [...this.evaluationRatings.values()],
        screening: {
          scripted: true,
          promptsObserved: [
            ...new Set(
              this.evaluationHistory
                .map((item) => item.screeningPrompt?.id)
                .filter(Boolean),
            ),
          ],
        },
      },
      null,
      2,
    );
  }
}

module.exports = {
  CaptionSessionManager,
  errorTarget,
  sanitizeScreeningPrompt,
};
