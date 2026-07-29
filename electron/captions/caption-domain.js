const crypto = require('crypto');

const TARGET_PENDING = Object.freeze({
  text: '',
  status: 'pending',
  revision: 0,
  passthrough: false,
});

function classifyScript(text) {
  const value = String(text || '').trim();
  if (!value) return 'unknown';

  const han = (value.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  const meaningful = han + latin;
  if (!meaningful) return 'unknown';

  // Treat substantive code-switching as mixed even when long English
  // engineering terms would otherwise dominate the character count. Short
  // acronyms such as DVT inside Chinese remain routed as Chinese.
  if (han >= 2 && latin >= 5) return 'mixed';

  const hanRatio = han / meaningful;
  const latinRatio = latin / meaningful;
  if (hanRatio >= 0.72) return 'zh';
  if (latinRatio >= 0.72) return 'en';
  return 'mixed';
}

function createTarget(text = '', options = {}) {
  return {
    text,
    status: options.status || (text ? 'provisional' : 'pending'),
    revision: options.revision || 0,
    passthrough: Boolean(options.passthrough),
    ...(options.firstRenderedAt ? { firstRenderedAt: options.firstRenderedAt } : {}),
    ...(options.finalizedAt ? { finalizedAt: options.finalizedAt } : {}),
    ...(options.error ? { error: options.error } : {}),
  };
}

function deriveAggregateStatus(english, chinese) {
  const states = [english.status, chinese.status];
  if (states.every((state) => state === 'final' || state === 'failed')) {
    return states.every((state) => state === 'failed') ? 'failed' : 'final';
  }
  if (states.includes('provisional')) return 'provisional';
  return 'pending';
}

function createCaptionEvent({
  sessionId,
  sequence,
  sourceChannel,
  providerItemId,
  sourceText,
  sourceStartedAt,
  sourceEndedAt,
  transcriptStatus = 'provisional',
  profile,
  transcriptionModel = 'gpt-live-transcribe',
  normalizationModel = 'gpt-5.4-nano',
  fastPath = true,
}) {
  const now = Date.now();
  const routedAs = classifyScript(sourceText);
  let english = { ...TARGET_PENDING };
  let chinese = { ...TARGET_PENDING };

  if (fastPath && routedAs === 'en') {
    english = createTarget(sourceText, {
      status: transcriptStatus,
      revision: 1,
      passthrough: true,
      firstRenderedAt: now,
      ...(transcriptStatus === 'final' ? { finalizedAt: now } : {}),
    });
  } else if (fastPath && routedAs === 'zh') {
    chinese = createTarget(sourceText, {
      status: transcriptStatus,
      revision: 1,
      passthrough: true,
      firstRenderedAt: now,
      ...(transcriptStatus === 'final' ? { finalizedAt: now } : {}),
    });
  }

  return {
    id: crypto.randomUUID(),
    sessionId,
    sequence,
    sourceChannel,
    providerItemId,
    sourceText,
    sourceLanguage: transcriptStatus === 'final' ? routedAs : 'unknown',
    routedAs,
    english,
    chinese,
    status: deriveAggregateStatus(english, chinese),
    sourceStartedAt,
    ...(sourceEndedAt ? { sourceEndedAt } : {}),
    firstTranscriptAt: now,
    ...(transcriptStatus === 'final' ? { finalTranscriptAt: now } : {}),
    provider: {
      transcriptionModel,
      normalizationModel,
      profile,
    },
    usage: {
      transcriptionAudioMs: 0,
      normalizationTokensIn: 0,
      normalizationTokensOut: 0,
      normalizationCalls: 0,
      estimatedCostUsd: 0,
    },
  };
}

function updateTarget(event, audience, update) {
  const key = audience === 'zh' ? 'chinese' : 'english';
  const previous = event[key];
  if (previous.status === 'final' && update.status !== 'final') return event;

  const next = {
    ...previous,
    ...update,
    revision: previous.revision + 1,
    firstRenderedAt:
      previous.firstRenderedAt ||
      (update.text ? update.firstRenderedAt || Date.now() : undefined),
    ...(update.status === 'final'
      ? { finalizedAt: update.finalizedAt || Date.now() }
      : {}),
  };

  return {
    ...event,
    [key]: next,
    status: deriveAggregateStatus(
      key === 'english' ? next : event.english,
      key === 'chinese' ? next : event.chinese,
    ),
  };
}

function projectForAudience(event, audience) {
  const target = audience === 'zh' ? event.chinese : event.english;
  return {
    id: event.id,
    sessionId: event.sessionId,
    sequence: event.sequence,
    sourceChannel: event.sourceChannel,
    sourceText: event.sourceText,
    sourceLanguage: event.sourceLanguage,
    audience,
    text: target.text,
    status: target.status,
    revision: target.revision,
    passthrough: target.passthrough,
    error: target.error,
    sourceStartedAt: event.sourceStartedAt,
    firstRenderedAt: target.firstRenderedAt,
    finalizedAt: target.finalizedAt,
  };
}

module.exports = {
  TARGET_PENDING,
  classifyScript,
  createCaptionEvent,
  createTarget,
  deriveAggregateStatus,
  projectForAudience,
  updateTarget,
};
