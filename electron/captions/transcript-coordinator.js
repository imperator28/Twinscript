function normalizedText(value) {
  return String(value || '')
    .toLocaleLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function bigrams(value) {
  const text = normalizedText(value);
  if (text.length < 2) return new Set(text ? [text] : []);
  const result = new Set();
  for (let index = 0; index < text.length - 1; index += 1) {
    result.add(text.slice(index, index + 2));
  }
  return result;
}

function diceSimilarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap += 1;
  }
  return (2 * overlap) / (a.size + b.size);
}

class TranscriptCoordinator {
  constructor({
    reorderWindowMs = 400,
    duplicateWindowMs = 1400,
    duplicateThreshold = 0.92,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onRelease = () => {},
    onDuplicate = () => {},
  } = {}) {
    this.reorderWindowMs = reorderWindowMs;
    this.duplicateWindowMs = duplicateWindowMs;
    this.duplicateThreshold = duplicateThreshold;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onRelease = onRelease;
    this.onDuplicate = onDuplicate;
    this.pending = [];
    this.recent = [];
    this.timer = null;
  }

  submit(event) {
    this.pending.push(event);
    if (!this.timer) {
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.flush();
      }, this.reorderWindowMs);
    }
  }

  flush() {
    const batch = this.pending
      .splice(0)
      .sort(
        (left, right) =>
          (left.startedAt || left.at) - (right.startedAt || right.at) ||
          left.channel.localeCompare(right.channel) ||
          String(left.itemId).localeCompare(String(right.itemId)),
      );
    for (const event of batch) {
      const duplicate = this.findDuplicate(event);
      if (duplicate) {
        const retained = this.onDuplicate({
          event,
          duplicateOf: duplicate,
          similarity: diceSimilarity(event.transcript, duplicate.transcript),
        });
        if (retained && retained !== duplicate) {
          this.recent = this.recent.filter((candidate) => candidate !== duplicate);
          this.recent.push(retained);
        }
      } else {
        this.recent.push(event);
        this.onRelease(event);
      }
      this.pruneRecent(event.at || this.now());
    }
  }

  findDuplicate(event) {
    return (
      [...this.recent]
        .reverse()
        .find(
          (candidate) =>
            candidate.channel !== event.channel &&
            Math.abs(
              (candidate.startedAt || candidate.at) -
                (event.startedAt || event.at),
            ) <= this.duplicateWindowMs &&
            diceSimilarity(candidate.transcript, event.transcript) >=
              this.duplicateThreshold,
        ) || null
    );
  }

  pruneRecent(at = this.now()) {
    const cutoff = at - this.duplicateWindowMs * 2;
    this.recent = this.recent.filter(
      (event) => (event.startedAt || event.at) >= cutoff,
    );
  }

  reset() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.pending = [];
    this.recent = [];
  }
}

module.exports = {
  TranscriptCoordinator,
  bigrams,
  diceSimilarity,
  normalizedText,
};
