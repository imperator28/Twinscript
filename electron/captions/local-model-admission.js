function admissionError() {
  const error = new Error('Local models cannot change during a meeting');
  error.code = 'meeting_active';
  return error;
}

class LocalModelAdmissionGate {
  constructor() {
    this.tail = Promise.resolve();
    this.releaseSession = null;
  }

  _serialize(operation) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    return previous.then(async () => {
      try {
        return await operation();
      } finally {
        release();
      }
    });
  }

  isSessionActive() {
    return Boolean(this.releaseSession);
  }

  acquireSession() {
    return this._serialize(() => {
      if (this.releaseSession) throw admissionError();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (this.releaseSession === release) this.releaseSession = null;
      };
      this.releaseSession = release;
      return release;
    });
  }

  runMutation(operation) {
    return this._serialize(async () => {
      if (this.releaseSession) throw admissionError();
      return operation();
    });
  }
}

module.exports = { LocalModelAdmissionGate };
