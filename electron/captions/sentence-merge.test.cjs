'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  endsSentence,
  invitesContinuation,
  joinFragments,
  mergeFragments,
  shouldMergeFragments,
} = require('./sentence-merge.js');

const fragment = (overrides = {}) => ({
  channel: 'microphone',
  sessionId: 'session-a',
  itemId: 'item-1',
  transcript: 'we need to hold this tolerance',
  startedAt: 1000,
  at: 2000,
  ...overrides,
});

test('endsSentence recognises terminal punctuation in both languages', () => {
  assert.equal(endsSentence('That is the plan.'), true);
  assert.equal(endsSentence('Is that the plan?'), true);
  assert.equal(endsSentence('这个方案可以。'), true);
  assert.equal(endsSentence('这样行吗？'), true);
  assert.equal(endsSentence('等一下……'), true);
});

test('endsSentence looks past closing quotes and brackets', () => {
  // A quoted sentence still ends where the punctuation is, not at the quote.
  assert.equal(endsSentence('he said "we ship Friday."'), true);
  assert.equal(endsSentence('（先确认公差。）'), true);
});

test('endsSentence rejects an unfinished fragment', () => {
  assert.equal(endsSentence('we need to hold this tolerance'), false);
  assert.equal(endsSentence('这个支架的公差'), false);
  assert.equal(endsSentence(''), false);
  assert.equal(endsSentence(undefined), false);
});

test('invitesContinuation detects an explicitly open clause', () => {
  assert.equal(invitesContinuation('first we check the fixture,'), true);
  assert.equal(invitesContinuation('需要确认三件事：'), true);
  assert.equal(invitesContinuation('that is settled.'), false);
});

test('joinFragments uses a space for latin and nothing for CJK', () => {
  assert.equal(
    joinFragments('we need to hold this', 'to plus or minus 0.2'),
    'we need to hold this to plus or minus 0.2',
  );
  // A space here would be visibly wrong to any Chinese reader.
  assert.equal(joinFragments('这个支架的公差', '控制在正负零点二毫米'), '这个支架的公差控制在正负零点二毫米');
  assert.equal(joinFragments('', 'only this'), 'only this');
  assert.equal(joinFragments('only this', ''), 'only this');
});

test('joinFragments handles a mixed-script boundary without a stray space', () => {
  // Inline code-switching is the norm in these meetings.
  assert.equal(joinFragments('这个 boss 的', 'wall thickness 是 1.2 毫米'), '这个 boss 的wall thickness 是 1.2 毫米');
});

test('an unfinished fragment merges with its continuation', () => {
  assert.equal(
    shouldMergeFragments({
      previous: fragment(),
      next: fragment({ itemId: 'item-2', transcript: 'to plus or minus 0.2 millimetres.' }),
      gapMs: 300,
    }),
    true,
  );
});

test('a completed sentence is never merged', () => {
  assert.equal(
    shouldMergeFragments({
      previous: fragment({ transcript: 'We hold it to 0.2 millimetres.' }),
      next: fragment({ itemId: 'item-2', transcript: 'Then we ship.' }),
      gapMs: 200,
    }),
    false,
  );
});

test('a trailing comma still merges even though punctuation is present', () => {
  assert.equal(
    shouldMergeFragments({
      previous: fragment({ transcript: 'first we check the fixture,' }),
      next: fragment({ itemId: 'item-2', transcript: 'then the tolerance.' }),
      gapMs: 200,
    }),
    true,
  );
});

test('fragments from different speakers never merge', () => {
  // Welding the remote party's words onto the operator's is the worst outcome
  // available here, so channel is checked before anything else.
  assert.equal(
    shouldMergeFragments({
      previous: fragment(),
      next: fragment({ channel: 'system', itemId: 'item-2', transcript: 'sure, go ahead.' }),
      gapMs: 100,
    }),
    false,
  );
});

test('fragments from different sessions never merge', () => {
  assert.equal(
    shouldMergeFragments({
      previous: fragment(),
      next: fragment({ sessionId: 'session-b', itemId: 'item-2' }),
      gapMs: 100,
    }),
    false,
  );
});

test('a long silence ends the sentence regardless of punctuation', () => {
  assert.equal(
    shouldMergeFragments({ previous: fragment(), next: fragment({ itemId: 'item-2' }), gapMs: 5000 }),
    false,
  );
});

test('merging is bounded in both count and length', () => {
  assert.equal(
    shouldMergeFragments({
      previous: fragment(),
      next: fragment({ itemId: 'item-2' }),
      gapMs: 200,
      mergedCount: 3,
    }),
    false,
    'a speaker who never uses full stops must not produce one endless caption',
  );
  assert.equal(
    shouldMergeFragments({
      previous: fragment({ transcript: 'x'.repeat(300) }),
      next: fragment({ itemId: 'item-2', transcript: 'y'.repeat(100) }),
      gapMs: 200,
    }),
    false,
  );
});

test('a capitalised follow-on is treated as a new sentence', () => {
  // Missing punctuation is common; a capital letter is the next best signal.
  assert.equal(
    shouldMergeFragments({
      previous: fragment({ transcript: 'that covers the fixture' }),
      next: fragment({ itemId: 'item-2', transcript: 'Next we should discuss cost.' }),
      gapMs: 200,
    }),
    false,
  );
});

test('mergeFragments spans the outer time bounds and records both items', () => {
  const merged = mergeFragments(
    fragment({ startedAt: 1000, at: 2000 }),
    fragment({ itemId: 'item-2', transcript: 'to 0.2 millimetres.', startedAt: 2100, at: 3000 }),
  );
  assert.equal(merged.transcript, 'we need to hold this tolerance to 0.2 millimetres.');
  assert.equal(merged.startedAt, 1000, 'latency is measured from when the speaker began');
  assert.equal(merged.at, 3000);
  assert.equal(merged.itemId, 'item-1', 'keeps the id the operator already saw');
  assert.deepEqual(merged.mergedItemIds, ['item-1', 'item-2']);
});

test('mergeFragments accumulates ids across three fragments', () => {
  const first = mergeFragments(fragment(), fragment({ itemId: 'item-2', transcript: 'and also' }));
  const second = mergeFragments(first, fragment({ itemId: 'item-3', transcript: 'the wall thickness.' }));
  assert.deepEqual(second.mergedItemIds, ['item-1', 'item-2', 'item-3']);
  assert.equal(second.itemId, 'item-1');
});
