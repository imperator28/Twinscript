const crypto = require('crypto');
const { EventEmitter } = require('events');

const MAX_LINE_BYTES = 1024 * 1024;
const REPLY_TYPES = {
  hello: 'capabilities',
  health: 'health',
  'model.prepare': 'model.ready',
  'translate.preview': 'translate.result',
  'translate.final': 'translate.result',
  shutdown: 'shutdown',
};

function localError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class LocalInferenceClient extends EventEmitter {
  constructor({ transport, timeoutMs = 30_000, generation = 1 }) {
    super();
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.generation = generation;
    this.pending = new Map();
    this.onMessage = (message) => this.accept(message);
    this.onClose = () => this.rejectAll(
      localError('local_host_closed', 'Local inference host closed'),
    );
    transport.on('message', this.onMessage);
    transport.on('close', this.onClose);
  }

  request(type, payload = {}, { signal, timeoutMs } = {}) {
    if (signal?.aborted) {
      return Promise.reject(localError('local_request_aborted', 'Local request aborted'));
    }
    const requestId = payload.requestId || crypto.randomUUID();
    const sessionId = payload.sessionId || 'local-host';
    const message = {
      protocolVersion: 1,
      ...payload,
      type,
      requestId,
      sessionId,
      generation: this.generation,
    };
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      return Promise.reject(localError('local_request_too_large', 'Local request exceeds 1 MiB'));
    }
    if (this.pending.has(requestId)) {
      return Promise.reject(localError('local_request_duplicate', 'Duplicate local request ID'));
    }

    return new Promise((resolve, reject) => {
      const duration = timeoutMs ?? this.timeoutMs;
      const timer = setTimeout(() => {
        this.finish(requestId);
        reject(localError('local_request_timeout', `Local ${type} request timed out`));
      }, duration);
      timer.unref?.();
      const onAbort = () => {
        try {
          const cancellation = this.transport.write(`${JSON.stringify({
          protocolVersion: 1,
          type: 'request.cancel',
          requestId,
          sessionId,
          generation: this.generation,
          })}\n`);
          cancellation?.catch?.(() => {});
        } catch {
          // The request is already being aborted; a closed cancellation pipe
          // must not replace the caller-visible abort reason.
        }
        this.finish(requestId);
        reject(localError('local_request_aborted', 'Local request aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        signal,
        onAbort,
        sessionId,
        expectedType: REPLY_TYPES[type] || null,
      });
      const rejectWrite = (error) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.finish(requestId);
        pending.reject(localError(
          'local_transport_write_failed',
          `Could not write to local inference host: ${error?.message || error}`,
        ));
      };
      try {
        const written = this.transport.write(line);
        written?.catch?.(rejectWrite);
      } catch (error) {
        rejectWrite(error);
      }
    });
  }

  accept(message) {
    if (!message || typeof message !== 'object') return false;
    const pending = this.pending.get(message.requestId);
    if (!pending) {
      this.emit('event', message);
      return false;
    }
    if (message.protocolVersion !== 1) {
      this.finish(message.requestId);
      pending.reject(localError('local_protocol_mismatch', 'Local host protocol mismatch'));
      return false;
    }
    if (message.generation !== this.generation) {
      this.finish(message.requestId);
      pending.reject(localError('local_generation_stale', 'Reply came from a replaced local host'));
      return false;
    }
    if (message.sessionId !== pending.sessionId) return false;
    if (message.type === 'error') {
      this.finish(message.requestId);
      pending.reject(localError(message.code || 'local_host_error', message.message || 'Local host error'));
      return true;
    }
    if (pending.expectedType && message.type !== pending.expectedType) return false;
    this.finish(message.requestId);
    pending.resolve(message);
    return true;
  }

  finish(requestId) {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.onAbort);
    this.pending.delete(requestId);
  }

  rejectAll(error) {
    for (const [requestId, pending] of this.pending) {
      this.finish(requestId);
      pending.reject(error);
    }
  }

  dispose() {
    this.transport.off('message', this.onMessage);
    this.transport.off('close', this.onClose);
    this.rejectAll(localError('local_client_disposed', 'Local inference client disposed'));
  }
}

module.exports = { LocalInferenceClient, MAX_LINE_BYTES };
