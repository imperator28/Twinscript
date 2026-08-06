/**
 * How many undecided meeting recordings are kept before the oldest are aged out.
 *
 * An operator who ends a meeting and immediately starts the next one never answers the
 * keep/delete prompt, and nothing previously aged those recordings out: they are
 * encrypted 24 kHz mono WAV chunks at ~2.9 MB per minute per channel, so a week of
 * ignored hour-long meetings is several gigabytes sitting in the pending directory
 * with no upper bound and nothing in the UI reporting it.
 */
const MAX_UNDECIDED_RECORDINGS = 5;

/**
 * Split undecided sessions into the ones that keep their audio and the ones whose
 * audio ages out, newest first.
 *
 * Only the AUDIO ages out. The transcript is already finalized in the visible session
 * directory and is never touched here - it is small, it is the part with lasting value,
 * and silently deleting it would be indefensible.
 *
 * Ordering is by start time, newest first, with the session id as a tiebreak so two
 * meetings recorded in the same millisecond cannot swap places between runs and make
 * the choice of what to delete nondeterministic.
 *
 * @param {Array<{sessionId: string, session?: {startedAt?: number}}>} pending
 * @param {{limit?: number}} [options]
 * @returns {{keep: Array, expire: Array}}
 */
function planPendingAudioRetention(pending, { limit = MAX_UNDECIDED_RECORDINGS } = {}) {
  const entries = Array.isArray(pending) ? pending.slice() : [];

  entries.sort((left, right) => {
    // Missing timestamps sort last rather than first: a recording whose start time
    // could not be read is the least safe thing to keep and the least useful.
    const leftStart = Number.isFinite(left?.session?.startedAt)
      ? left.session.startedAt
      : -Infinity;
    const rightStart = Number.isFinite(right?.session?.startedAt)
      ? right.session.startedAt
      : -Infinity;
    if (leftStart !== rightStart) return rightStart - leftStart;
    return String(left?.sessionId ?? '').localeCompare(String(right?.sessionId ?? ''));
  });

  // A non-positive or unusable limit means "keep everything" rather than "delete
  // everything": a misconfigured cap must never be the reason audio disappears.
  if (!Number.isFinite(limit) || limit <= 0) {
    return { keep: entries, expire: [] };
  }

  return { keep: entries.slice(0, limit), expire: entries.slice(limit) };
}

module.exports = { MAX_UNDECIDED_RECORDINGS, planPendingAudioRetention };
