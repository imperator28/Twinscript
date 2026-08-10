class HybridLocalInferenceClient {
  constructor({ base, translation = null }) {
    this.base = base;
    this.translation = translation;
  }

  async request(type, payload = {}, options = {}) {
    if (type === 'translate.preview' || type === 'translate.final') {
      if (!this.translation) {
        const error = new Error('Local Hy-MT2 runtime is not configured');
        error.code = 'local_translation_unavailable';
        throw error;
      }
      return this.translation.translate(type, payload, options);
    }
    const response = await this.base.request(type, payload, options);
    if (type === 'hello' && this.translation) {
      return {
        ...response,
        models: [
          ...(Array.isArray(response.models) ? response.models : []),
          this.translation.health(),
        ],
      };
    }
    if (type === 'health' && this.translation) {
      return {
        ...response,
        models: {
          ...(response.models && !Array.isArray(response.models) ? response.models : {}),
          'hy-mt2-1.8b': this.translation.health(),
        },
      };
    }
    return response;
  }

  on(type, listener) {
    this.base.on?.(type, listener);
    return this;
  }

  off(type, listener) {
    this.base.off?.(type, listener);
    return this;
  }

  dispose() {
    this.base.dispose?.();
  }
}

module.exports = { HybridLocalInferenceClient };
