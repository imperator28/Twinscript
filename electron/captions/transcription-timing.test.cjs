const test = require('node:test');
const assert = require('node:assert/strict');
const { LiveTranscriptionSession } = require('./live-transcription-session');
function harness() {
  const events = [];
  const s = new LiveTranscriptionSession({ channel: 'system', apiKey: 'test', settings: {}, onEvent: e => events.push(e) });
  s.connected = true;
  s.socket = { readyState: 1, send() {}, close() {} };
  return { s, events, receive: e => s.handleMessage(Buffer.from(JSON.stringify(e))) };
}
test('explicit commits correlate source timing without server VAD, including reordered completions', () => {
  const { s, events, receive } = harness();
  for (const id of ['one', 'two']) {
    s.sendPcm(new Int16Array(2400));
    s.commitAudioTurn();
    receive({ type: 'input_audio_buffer.committed', item_id: id });
  }
  const start = s.startedAtByItem.get('one');
  for (const id of ['two', 'one']) receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: id });
  const transcript = events.find(e => e.itemId === 'one');
  assert.equal(transcript.startedAt, start);
  assert.equal(transcript.timingBasis, 'local-send');
  assert.equal(transcript.channel, 'system');
  assert.equal(s.pendingCompletions, 0);
  s.close();
});
test('transcription.failed drains finish and clears partial state without publishing partial text', async () => {
  const { s, events, receive } = harness();
  s.sendPcm(new Int16Array(2400));
  const finishing = s.finish({ timeoutMs: 1000 });
  receive({ type: 'input_audio_buffer.committed', item_id: 'failed' });
  s.partialByItem.set('failed', 'unfinished');
  receive({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'failed', error: { code: 'audio_unintelligible' } });
  await finishing;
  assert.equal(s.partialByItem.size, 0);
  assert.equal(s.startedAtByItem.size, 0);
  assert.equal(events.at(-1).code, 'audio_unintelligible');
  assert.ok(!events.some(e => e.type === 'transcript'));
});
test('short buffered chunks are retained until an API-valid commit is possible', () => {
  const { s } = harness();
  s.sendPcm(new Int16Array(1200));
  s.commitAudioTurn();
  assert.equal(s.turnAudioMs, 50);
  s.sendPcm(new Int16Array(1200));
  s.commitAudioTurn();
  assert.equal(s.pendingCompletions, 1);
  s.close();
});
