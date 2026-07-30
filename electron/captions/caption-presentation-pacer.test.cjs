const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CaptionPresentationPacer,
  clampPaceMs,
} = require('./caption-presentation-pacer');

test('caption presentation pace is clamped to a readable supported range', () => {
  assert.equal(clampPaceMs(10), 400);
  assert.equal(clampPaceMs(1200), 1200);
  assert.equal(clampPaceMs(9000), 3000);
  assert.equal(clampPaceMs('invalid'), 1200);
});

test('presentation pacing coalesces rapid revisions and advances both audiences together', () => {
  let now = 1000;
  let scheduled = null;
  const presented = [];
  const pacer = new CaptionPresentationPacer({
    paceMs: 1200,
    now: () => now,
    onPresent: (event) => presented.push(event),
    setTimer: (callback, delay) => {
      scheduled = { callback, delay };
      return 1;
    },
    clearTimer: () => {
      scheduled = null;
    },
  });

  pacer.enqueue({ id: 'first', revision: 0 });
  assert.deepEqual(presented, [{ id: 'first', revision: 0 }]);

  pacer.enqueue({ id: 'second', revision: 0 });
  pacer.enqueue({ id: 'second', revision: 1 });
  assert.equal(scheduled.delay, 1200);

  now += scheduled.delay;
  scheduled.callback();
  assert.deepEqual(presented, [
    { id: 'first', revision: 0 },
    { id: 'second', revision: 1 },
  ]);
});
