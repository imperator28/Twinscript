const { EventEmitter } = require('events');


class HybridLocalInferenceClient extends EventEmitter {
  constructor({ base, translation = null }) {
    super();
    this.base = null;
    this.translation = translation;
    this.onBaseEvent = (event) => this.emit('event', event);
    this.replaceBase(base);
  }

  replaceBase(base) {
    this.base?.off?.('event', this.onBaseEvent);
    this.base = base;
    this.base?.on?.('event', this.onBaseEvent);
    return this;
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
    if (!this.base) {
      const error = new Error('Local inference host is restarting');
      error.code = 'local_host_restarting';
      throw error;
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

  dispose({ disposeBase = true } = {}) {
    const base = this.base;
    this.replaceBase(null);
    if (disposeBase) base?.dispose?.();
    this.removeAllListeners();
  }
}

module.exports = { HybridLocalInferenceClient };
