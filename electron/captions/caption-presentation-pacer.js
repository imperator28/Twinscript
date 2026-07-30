const MIN_PACE_MS = 400;
const MAX_PACE_MS = 3000;
const DEFAULT_PACE_MS = 1200;

function clampPaceMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_PACE_MS;
  return Math.round(Math.max(MIN_PACE_MS, Math.min(MAX_PACE_MS, numeric)));
}

class CaptionPresentationPacer {
  constructor({
    onPresent,
    paceMs = DEFAULT_PACE_MS,
    now = () => Date.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (timer) => clearTimeout(timer),
  }) {
    this.onPresent = onPresent;
    this.paceMs = clampPaceMs(paceMs);
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.pending = [];
    this.lastPresentedAt = null;
    this.timer = null;
  }

  setPaceMs(value) {
    this.paceMs = clampPaceMs(value);
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.schedule();
    return this.paceMs;
  }

  enqueue(event) {
    const existingIndex = this.pending.findIndex(
      (pending) => pending.id === event.id,
    );
    if (existingIndex >= 0) {
      this.pending[existingIndex] = event;
    } else {
      this.pending.push(event);
    }
    this.schedule();
  }

  schedule() {
    if (this.timer !== null || this.pending.length === 0) return;
    if (this.lastPresentedAt === null) {
      this.presentNext();
      return;
    }
    const remaining = Math.max(
      0,
      this.paceMs - (this.now() - this.lastPresentedAt),
    );
    if (remaining === 0) {
      this.presentNext();
      return;
    }
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.presentNext();
    }, remaining);
  }

  presentNext() {
    const event = this.pending.shift();
    if (!event) return;
    this.lastPresentedAt = this.now();
    this.onPresent(event);
    this.schedule();
  }

  reset() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.pending = [];
    this.lastPresentedAt = null;
  }
}

module.exports = {
  CaptionPresentationPacer,
  DEFAULT_PACE_MS,
  MAX_PACE_MS,
  MIN_PACE_MS,
  clampPaceMs,
};
