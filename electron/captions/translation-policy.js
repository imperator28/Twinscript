function createTranslationPolicy(settings = {}) {
  const finalBackend = settings.finalTranslationModel === 'hy-mt2-local'
    ? 'hy-mt2-local'
    : 'luna';
  const previewBackend = settings.provisionalTranslation !== true
    ? null
    : settings.localTranslationAcceleration === true
      ? 'hy-mt2-local'
      : finalBackend;
  return { previewBackend, finalBackend };
}

function translationState() {
  const values = new Map();

  function accept(candidate, authoritative) {
    const current = values.get(candidate.utteranceId);
    if (current?.authoritative) return false;
    if (current && Number(candidate.sourceRevision) < current.sourceRevision) return false;
    values.set(candidate.utteranceId, {
      ...candidate,
      sourceRevision: Number(candidate.sourceRevision) || 0,
      authoritative,
    });
    return true;
  }

  return {
    acceptPreview: (candidate) => accept(candidate, false),
    acceptFinal(candidate) {
      const current = values.get(candidate.utteranceId);
      if (current?.authoritative && Number(candidate.sourceRevision) < current.sourceRevision) {
        return false;
      }
      values.set(candidate.utteranceId, {
        ...candidate,
        sourceRevision: Number(candidate.sourceRevision) || 0,
        authoritative: true,
      });
      return true;
    },
    get: (utteranceId) => values.get(utteranceId),
  };
}

module.exports = { createTranslationPolicy, translationState };
