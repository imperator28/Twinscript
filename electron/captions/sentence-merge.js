'use strict';

// Deciding whether two consecutive final transcripts are really one sentence.
//
// The speech provider ends an item on a voice-activity pause, and people pause in
// the middle of sentences - to think, to breathe, to find a word. Each item is
// then translated independently, so "we need to hold this tolerance" / "to plus or
// minus two tenths" becomes two translations neither of which carries the meaning
// of the whole. In Chinese the damage is worse, because a trailing measure word or
// a dangling 的 has to be guessed at.
//
// So a final that does not look like the end of a sentence is held briefly to see
// whether the next one continues it. This is a latency trade, taken deliberately:
// provisional captions still appear immediately, so the operator and the audience
// see text while the sentence completes. Only the finalized, translated line waits.

// Sentence-final punctuation in both languages, plus the closing quotes and
// brackets that legitimately follow it. The full-width closers matter as much as
// the ASCII ones: Chinese text ends parentheses with `）`, not `)`, and omitting
// them made a properly finished sentence look unfinished and eligible for merging.
const TERMINAL_PUNCTUATION =
  /[.!?。！？…]+["'”’)\]）］｝〉》」』】〕]*\s*$/u;

// A trailing comma, colon, semicolon or dash is a positive signal of continuation:
// the speaker has explicitly not finished.
const CONTINUATION_PUNCTUATION = /[,，、;；:：\-—–]\s*$/u;

// Latin script needs a space when joining; CJK does not, and inserting one there
// is visible and wrong.
const CJK_EDGE = /[㐀-鿿豈-﫿　-〿＀-￯]/u;

/** Whether `text` reads as a completed sentence. */
function endsSentence(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return TERMINAL_PUNCTUATION.test(value);
}

/** Whether `text` explicitly signals more is coming. */
function invitesContinuation(text) {
  return CONTINUATION_PUNCTUATION.test(String(text || '').trim());
}

/**
 * Join two fragments with the separator their scripts require.
 *
 * Chinese and Japanese do not separate words with spaces, so joining
 * "这个支架的公差" and "控制在正负零点二毫米" with a space produces text no reader
 * would write. Latin fragments need exactly one space.
 */
function joinFragments(left, right) {
  const start = String(left || '').trim();
  const end = String(right || '').trim();
  if (!start) return end;
  if (!end) return start;
  const boundary = start.slice(-1) + end.slice(0, 1);
  if (CJK_EDGE.test(boundary)) return `${start}${end}`;
  return `${start} ${end}`;
}

/**
 * Should `next` be folded into the held fragment `previous`?
 *
 * Every guard here exists to stop a merge that would be wrong rather than merely
 * unhelpful, because a bad merge welds two unrelated utterances into one caption.
 */
function shouldMergeFragments({
  previous,
  next,
  gapMs,
  mergedCount = 0,
  maxMergedFragments = 3,
  maxGapMs = 1200,
  maxMergedChars = 320,
} = {}) {
  if (!previous || !next) return false;
  // Never across speakers: the microphone and the meeting are different people.
  if (previous.channel !== next.channel) return false;
  // Never across sessions; a new session is a new conversation.
  if (previous.sessionId && next.sessionId && previous.sessionId !== next.sessionId) {
    return false;
  }
  const previousText = String(previous.transcript || '').trim();
  const nextText = String(next.transcript || '').trim();
  if (!previousText || !nextText) return false;

  // A completed sentence is left alone, unless it ended on a comma-like mark.
  if (endsSentence(previousText) && !invitesContinuation(previousText)) return false;

  // Bound the result so a speaker who never uses full stops cannot produce one
  // enormous caption that scrolls the whole overlay.
  if (previousText.length + nextText.length > maxMergedChars) return false;
  if (mergedCount >= maxMergedFragments) return false;

  // A long silence means a new thought, not a continuation, even mid-sentence.
  if (Number.isFinite(gapMs) && gapMs > maxGapMs) return false;

  // A fragment that starts with a capital letter and follows text with no
  // continuation mark is more likely a new sentence the recogniser failed to
  // punctuate than a continuation.
  if (!invitesContinuation(previousText) && /^[A-Z]/.test(nextText)) return false;

  return true;
}

/**
 * Combine two transcript events into one, preserving the outer time bounds.
 *
 * The merged event keeps the FIRST item's id so downstream keying, provisional
 * cancellation, and duplicate suppression continue to refer to the utterance the
 * operator already saw appear.
 */
function mergeFragments(previous, next) {
  const startedAt = Math.min(
    previous.startedAt ?? previous.at ?? 0,
    next.startedAt ?? next.at ?? 0,
  );
  return {
    ...previous,
    transcript: joinFragments(previous.transcript, next.transcript),
    startedAt: startedAt || previous.startedAt || previous.at,
    at: next.at ?? previous.at,
    mergedItemIds: [
      ...(previous.mergedItemIds || [previous.itemId]),
      next.itemId,
    ].filter((value) => value !== undefined && value !== null),
  };
}

module.exports = {
  CONTINUATION_PUNCTUATION,
  TERMINAL_PUNCTUATION,
  endsSentence,
  invitesContinuation,
  joinFragments,
  mergeFragments,
  shouldMergeFragments,
};
