const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_UNDECIDED_RECORDINGS,
  planPendingAudioRetention,
} = require('./pending-audio-retention');

const at = (sessionId, startedAt) => ({ sessionId, session: { startedAt } });
const ids = (entries) => entries.map((entry) => entry.sessionId);

test('keeps everything while under the cap', () => {
  const { keep, expire } = planPendingAudioRetention([at('a', 3), at('b', 1)]);
  assert.deepEqual(ids(keep), ['a', 'b']);
  assert.deepEqual(expire, []);
});

test('keeps the newest five and ages out the rest', () => {
  const pending = [1, 2, 3, 4, 5, 6, 7].map((n) => at(`s${n}`, n * 1000));
  const { keep, expire } = planPendingAudioRetention(pending);
  assert.equal(keep.length, MAX_UNDECIDED_RECORDINGS);
  assert.deepEqual(ids(keep), ['s7', 's6', 's5', 's4', 's3']);
  assert.deepEqual(ids(expire), ['s2', 's1']);
});

test('orders newest first regardless of input order', () => {
  const { keep } = planPendingAudioRetention([at('old', 1), at('new', 9), at('mid', 5)]);
  assert.deepEqual(ids(keep), ['new', 'mid', 'old']);
});

test('breaks ties by session id so deletions are deterministic', () => {
  // Two meetings stamped in the same millisecond must not swap places between runs;
  // otherwise which one gets deleted at the boundary is a coin toss.
  const pending = [at('b', 5), at('a', 5), at('c', 5)];
  const first = ids(planPendingAudioRetention(pending, { limit: 2 }).keep);
  const second = ids(planPendingAudioRetention(pending.slice().reverse(), { limit: 2 }).keep);
  assert.deepEqual(first, second);
  assert.deepEqual(first, ['a', 'b']);
});

test('sorts entries with an unreadable start time last', () => {
  // A recording whose manifest could not be read is the least useful thing to keep,
  // and must not displace one that is intact.
  const { keep, expire } = planPendingAudioRetention(
    [{ sessionId: 'broken' }, at('good', 1)],
    { limit: 1 },
  );
  assert.deepEqual(ids(keep), ['good']);
  assert.deepEqual(ids(expire), ['broken']);
});

test('treats a non-numeric start time as unreadable rather than sorting on NaN', () => {
  const { keep } = planPendingAudioRetention(
    [{ sessionId: 'nan', session: { startedAt: Number.NaN } }, at('good', 1)],
    { limit: 1 },
  );
  assert.deepEqual(ids(keep), ['good']);
});

test('a misconfigured cap keeps everything instead of deleting everything', () => {
  // Fail-safe direction: audio must never disappear because a limit was wrong.
  for (const limit of [0, -3, Number.NaN, Infinity, null, 'five']) {
    const { keep, expire } = planPendingAudioRetention([at('a', 2), at('b', 1)], {
      limit,
    });
    assert.equal(keep.length, 2, `limit ${String(limit)} should keep both`);
    assert.deepEqual(expire, [], `limit ${String(limit)} should expire nothing`);
  }
});

test('an omitted cap falls back to the documented default', () => {
  const pending = [1, 2, 3, 4, 5, 6].map((n) => at(`s${n}`, n));
  assert.equal(planPendingAudioRetention(pending, {}).keep.length, 5);
  assert.equal(planPendingAudioRetention(pending).keep.length, 5);
});

test('handles an empty or absent list without throwing', () => {
  assert.deepEqual(planPendingAudioRetention([]), { keep: [], expire: [] });
  assert.deepEqual(planPendingAudioRetention(undefined), { keep: [], expire: [] });
  assert.deepEqual(planPendingAudioRetention(null), { keep: [], expire: [] });
});

test('does not mutate the caller list', () => {
  const pending = [at('a', 1), at('b', 9)];
  planPendingAudioRetention(pending);
  assert.deepEqual(ids(pending), ['a', 'b']);
});

test('the cap is five', () => {
  assert.equal(MAX_UNDECIDED_RECORDINGS, 5);
});
