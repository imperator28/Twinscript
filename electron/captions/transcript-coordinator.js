const {
  endsSentence,
  invitesContinuation,
  mergeFragments,
  shouldMergeFragments,
} = require('./sentence-merge.js');

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
    // How long an apparently unfinished sentence waits for its continuation.
    //
    // Chosen against the W1 latency gate: finalized-source-to-both-audiences has a
    // 2.5s median budget, and only fragments wait at all - a sentence that ends in
    // punctuation is released immediately. Provisional captions keep appearing
    // throughout, so nothing on screen freezes while the sentence completes.
    sentenceHoldMs = 900,
    mergeSentenceFragments = true,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onRelease = () => {},
    onDuplicate = () => {},
  } = {}) {
    this.reorderWindowMs = reorderWindowMs;
    this.duplicateWindowMs = duplicateWindowMs;
    this.duplicateThreshold = duplicateThreshold;
    this.sentenceHoldMs = sentenceHoldMs;
    this.mergeSentenceFragments = mergeSentenceFragments;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onRelease = onRelease;
    this.onDuplicate = onDuplicate;
    this.pending = [];
    this.recent = [];
    this.timer = null;
    // One held fragment per channel: `{ event, mergedCount, timer }`.
    this.held = new Map();
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
      // Sentence assembly happens before duplicate detection on purpose: two
      // halves of one sentence are not duplicates of each other, and comparing a
      // fragment against recent history invites a false match on the shared words.
      const assembled = this.absorbFragment(event);
      if (!assembled) continue;
      this.dispatch(assembled);
    }
  }

  /**
   * Fold `event` into a held fragment, hold it, or pass it straight through.
   *
   * Returns the event to dispatch now, or null when it is being held.
   */
  absorbFragment(event) {
    if (!this.mergeSentenceFragments) return event;

    const channel = event.channel;
    const holder = this.held.get(channel);

    if (holder) {
      this.clearTimer(holder.timer);
      this.held.delete(channel);
      const gapMs =
        (event.startedAt ?? event.at ?? 0) - (holder.event.at ?? 0);
      if (
        shouldMergeFragments({
          previous: holder.event,
          next: event,
          gapMs,
          mergedCount: holder.mergedCount,
        })
      ) {
        const merged = mergeFragments(holder.event, event);
        // The combined text may still be unfinished, so re-evaluate rather than
        // releasing: three short fragments are one sentence more often than two.
        return this.holdOrRelease(merged, holder.mergedCount + 1);
      }
      // No merge: the held fragment stands on its own and goes out first so
      // ordering is preserved.
      this.dispatch(holder.event);
    }

    return this.holdOrRelease(event, 0);
  }

  holdOrRelease(event, mergedCount) {
    const text = String(event.transcript || '').trim();
    const complete = endsSentence(text) && !invitesContinuation(text);
    if (complete || mergedCount >= 3 || this.sentenceHoldMs <= 0) {
      return event;
    }
    const timer = this.setTimer(() => {
      const holder = this.held.get(event.channel);
      this.held.delete(event.channel);
      // The continuation never arrived; the fragment is all the speaker said.
      if (holder) this.dispatch(holder.event);
    }, this.sentenceHoldMs);
    this.held.set(event.channel, { event, mergedCount, timer });
    return null;
  }

  dispatch(event) {
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
    // Held fragments are dropped rather than released: a session boundary means
    // the continuation is never coming, and emitting half a sentence into a
    // brand-new session would attribute it to the wrong conversation. Their
    // timers must be cleared or they fire after the session is gone.
    for (const holder of this.held.values()) this.clearTimer(holder.timer);
    this.held.clear();
  }

  /**
   * Release every held fragment immediately.
   *
   * Called when a session stops cleanly: the operator has finished speaking, so a
   * trailing fragment is the last thing they said and should still be captioned
   * rather than silently discarded.
   */
  flushHeld() {
    const holders = [...this.held.values()];
    for (const holder of holders) this.clearTimer(holder.timer);
    this.held.clear();
    for (const holder of holders) this.dispatch(holder.event);
  }
}

module.exports = {
  TranscriptCoordinator,
  bigrams,
  diceSimilarity,
  normalizedText,
};
