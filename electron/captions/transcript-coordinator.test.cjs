'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TranscriptCoordinator } = require('./transcript-coordinator.js');

// A controllable clock and timer queue, so sentence assembly can be tested without
// waiting real milliseconds and without flakiness.
function harness(options = {}) {
  let clock = 1000;
  const timers = new Map();
  let nextId = 1;
  const released = [];
  const duplicates = [];

  const coordinator = new TranscriptCoordinator({
    now: () => clock,
    setTimer: (fn, delay) => {
      const id = nextId++;
      timers.set(id, { fn, at: clock + delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    onRelease: (event) => released.push(event),
    onDuplicate: ({ event }) => {
      duplicates.push(event);
      return event;
    },
    ...options,
  });

  return {
    coordinator,
    released,
    duplicates,
    /** Advance time and fire every timer that is now due. */
    advance(ms) {
      clock += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    at: () => clock,
    setClock(value) {
      clock = value;
    },
  };
}

const final = (overrides = {}) => ({
  channel: 'microphone',
  sessionId: 'session-a',
  itemId: 'item-1',
  transcript: 'we need to hold this tolerance',
  startedAt: 1000,
  at: 1200,
  ...overrides,
});

test('a completed sentence is released without waiting for a continuation', () => {
  const h = harness();
  h.coordinator.submit(final({ transcript: 'We hold it to 0.2 millimetres.' }));
  h.advance(400); // reorder window only
  assert.equal(h.released.length, 1);
  assert.equal(h.released[0].transcript, 'We hold it to 0.2 millimetres.');
});

test('two halves of one sentence are released as a single caption', () => {
  // The reported defect: each half was translated on its own, so neither carried
  // the meaning of the whole.
  const h = harness();
  h.coordinator.submit(final({ itemId: 'a', transcript: 'we need to hold this tolerance' }));
  h.advance(400);
  assert.equal(h.released.length, 0, 'the fragment is held, not released');

  h.coordinator.submit(
    final({ itemId: 'b', transcript: 'to plus or minus 0.2 millimetres.', startedAt: 1500, at: 1800 }),
  );
  h.advance(400);

  assert.equal(h.released.length, 1, 'exactly one caption, not two');
  assert.equal(
    h.released[0].transcript,
    'we need to hold this tolerance to plus or minus 0.2 millimetres.',
  );
  assert.deepEqual(h.released[0].mergedItemIds, ['a', 'b']);
});

test('a held fragment is released on its own when no continuation arrives', () => {
  const h = harness();
  h.coordinator.submit(final({ transcript: 'we need to hold this tolerance' }));
  h.advance(400);
  assert.equal(h.released.length, 0);
  // The speaker simply stopped there.
  h.advance(900);
  assert.equal(h.released.length, 1);
  assert.equal(h.released[0].transcript, 'we need to hold this tolerance');
});

test('a fragment followed by an unrelated sentence releases both, in order', () => {
  const h = harness();
  h.coordinator.submit(final({ itemId: 'a', transcript: 'that covers the fixture' }));
  h.advance(400);
  h.coordinator.submit(
    final({ itemId: 'b', transcript: 'Next we should discuss cost.', startedAt: 1500, at: 1800 }),
  );
  h.advance(400);

  assert.equal(h.released.length, 2);
  assert.equal(h.released[0].transcript, 'that covers the fixture');
  assert.equal(h.released[1].transcript, 'Next we should discuss cost.');
});

test('fragments on different channels are assembled independently', () => {
  // A held microphone fragment must not swallow the meeting channel's speech.
  const h = harness();
  h.coordinator.submit(final({ channel: 'microphone', itemId: 'm1', transcript: 'so the plan is' }));
  h.coordinator.submit(
    final({ channel: 'system', itemId: 's1', transcript: 'Sounds good to me.', startedAt: 1100, at: 1300 }),
  );
  h.advance(400);

  // The system sentence is complete and goes out; the microphone fragment waits.
  assert.equal(h.released.length, 1);
  assert.equal(h.released[0].channel, 'system');

  h.coordinator.submit(
    final({ channel: 'microphone', itemId: 'm2', transcript: 'to ship on Friday.', startedAt: 1500, at: 1700 }),
  );
  h.advance(400);
  const microphone = h.released.filter((event) => event.channel === 'microphone');
  assert.equal(microphone.length, 1);
  assert.equal(microphone[0].transcript, 'so the plan is to ship on Friday.');
});

test('three short fragments assemble into one sentence', () => {
  const h = harness();
  h.coordinator.submit(final({ itemId: 'a', transcript: 'the wall thickness' }));
  h.advance(400);
  h.coordinator.submit(final({ itemId: 'b', transcript: 'of this boss', startedAt: 1400, at: 1600 }));
  h.advance(400);
  h.coordinator.submit(final({ itemId: 'c', transcript: 'is 1.2 millimetres.', startedAt: 1800, at: 2000 }));
  h.advance(400);

  assert.equal(h.released.length, 1);
  assert.equal(h.released[0].transcript, 'the wall thickness of this boss is 1.2 millimetres.');
});

test('assembly is bounded so an unpunctuated speaker still gets captions', () => {
  // Someone who never finishes a sentence must not accumulate forever.
  const h = harness();
  let at = 1000;
  for (let index = 0; index < 6; index++) {
    h.coordinator.submit(
      final({ itemId: `f${index}`, transcript: `fragment ${index}`, startedAt: at, at: at + 150 }),
    );
    at += 300;
    h.advance(400);
  }
  h.advance(900);
  assert.ok(h.released.length >= 2, 'output is not withheld indefinitely');
  for (const event of h.released) {
    assert.ok(event.transcript.length < 320, 'no single caption grows without bound');
  }
});

test('a long pause ends the sentence even without punctuation', () => {
  const h = harness();
  h.coordinator.submit(final({ itemId: 'a', transcript: 'so the tolerance is' }));
  h.advance(400);
  // Past both the hold window and the merge gap limit.
  h.advance(2000);
  assert.equal(h.released.length, 1);

  h.coordinator.submit(
    final({ itemId: 'b', transcript: 'anyway lets move on', startedAt: 5000, at: 5200 }),
  );
  h.advance(400);
  h.advance(900);
  assert.equal(h.released.length, 2, 'the later fragment is its own caption');
});

test('reset drops held fragments and their timers', () => {
  const h = harness();
  h.coordinator.submit(final({ transcript: 'half a sentence' }));
  h.advance(400);
  assert.equal(h.released.length, 0);

  h.coordinator.reset();
  h.advance(5000);
  assert.equal(
    h.released.length,
    0,
    'a fragment must not surface inside the next session',
  );
});

test('flushHeld emits a trailing fragment when a session stops cleanly', () => {
  const h = harness();
  h.coordinator.submit(final({ transcript: 'and the last thing I wanted to say' }));
  h.advance(400);
  assert.equal(h.released.length, 0);

  h.coordinator.flushHeld();
  assert.equal(h.released.length, 1, 'the operator still said it');
});

test('merging can be disabled entirely', () => {
  const h = harness({ mergeSentenceFragments: false });
  h.coordinator.submit(final({ itemId: 'a', transcript: 'first half' }));
  h.advance(400);
  assert.equal(h.released.length, 1, 'no holding when the feature is off');
});

test('cross-channel duplicate suppression still works through assembly', () => {
  // Suppression compares complete utterances; assembly must not bypass it.
  const h = harness();
  h.coordinator.submit(
    final({ channel: 'system', itemId: 's1', transcript: 'Can we move the DVT build?' }),
  );
  h.advance(400);
  h.coordinator.submit(
    final({
      channel: 'microphone',
      itemId: 'm1',
      transcript: 'Can we move the DVT build?',
      startedAt: 1050,
      at: 1250,
    }),
  );
  h.advance(400);
  assert.equal(h.duplicates.length, 1, 'the echo through the microphone is caught');
});
