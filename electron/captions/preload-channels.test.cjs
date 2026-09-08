// Every channel the preload offers has to be in its own allowlist.
//
// `subscribe()` throws 'Unsupported caption event subscription' for anything not
// in EVENT_CHANNELS. Adding an `onX` helper without adding its channel therefore
// ships a method that exists, is callable, and throws the moment a surface uses
// it - and optional chaining does not help, because the method is defined.
//
// That shipped once: the session HUD subscribed to 'captions:session-hud-dock',
// the throw landed inside a useEffect, the error boundary caught it, and its
// message overflowed a 36px window. The visible result was a blank pill with a
// scrollbar, which looks like a rendering bug rather than a missing string in a
// Set two files away.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const PRELOAD = path.join(__dirname, '..', 'captions-preload.js');
const source = fs.readFileSync(PRELOAD, 'utf8');

function allowlistedChannels() {
  const block = source.slice(
    source.indexOf('const EVENT_CHANNELS'),
    source.indexOf(']);', source.indexOf('const EVENT_CHANNELS')),
  );
  return new Set([...block.matchAll(/'([^']+)'/g)].map((match) => match[1]));
}

/** Channels passed to subscribe() anywhere in the preload. */
function subscribedChannels() {
  return [...source.matchAll(/subscribe\(\s*'([^']+)'/g)].map((m) => m[1]);
}

test('every subscribed channel is allowlisted', () => {
  const allowed = allowlistedChannels();
  const used = subscribedChannels();
  assert.ok(used.length > 5, 'expected the preload to expose several subscriptions');
  const missing = used.filter((channel) => !allowed.has(channel));
  assert.deepEqual(
    missing,
    [],
    `these channels would throw at runtime: ${missing.join(', ')}`,
  );
});

test('the allowlist has no entries nothing subscribes to', () => {
  // A stale entry is harmless but misleading: it suggests a surface listens to
  // something no code reads.
  const allowed = [...allowlistedChannels()];
  const used = new Set(subscribedChannels());
  const unused = allowed.filter((channel) => !used.has(channel));
  assert.deepEqual(unused, [], `nothing subscribes to: ${unused.join(', ')}`);
});

test('the session HUD dock channel in particular is allowlisted', () => {
  assert.ok(allowlistedChannels().has('captions:session-hud-dock'));
});
