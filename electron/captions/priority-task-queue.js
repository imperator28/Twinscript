function abortError() {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

class PriorityTaskQueue {
  constructor({ concurrency = 2, maxQueue = 24 } = {}) {
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
    this.running = 0;
    this.queue = [];
    this.order = 0;
  }

  run(task, { priority = 0, signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.queue.length >= this.maxQueue) {
      const error = new Error('Normalization queue is full');
      error.code = 'normalization_backpressure';
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const item = {
        task,
        priority,
        signal,
        resolve,
        reject,
        order: this.order++,
        onAbort: null,
      };
      item.onAbort = () => {
        const index = this.queue.indexOf(item);
        if (index >= 0) {
          this.queue.splice(index, 1);
          reject(abortError());
        }
      };
      signal?.addEventListener('abort', item.onAbort, { once: true });
      this.queue.push(item);
      this.queue.sort(
        (left, right) =>
          right.priority - left.priority || left.order - right.order,
      );
      this.drain();
    });
  }

  drain() {
    while (this.running < this.concurrency && this.queue.length) {
      const item = this.queue.shift();
      item.signal?.removeEventListener('abort', item.onAbort);
      if (item.signal?.aborted) {
        item.reject(abortError());
        continue;
      }
      this.running += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.running -= 1;
          this.drain();
        });
    }
  }

  snapshot() {
    return { running: this.running, queued: this.queue.length };
  }
}

module.exports = { PriorityTaskQueue, abortError };
