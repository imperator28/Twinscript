const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  appendTranscriptRecord,
  createSessionDirectory,
  finalizeTranscript,
  listPendingAudioDecisions,
  listSessions,
  readSessionManifest,
  readTranscriptRecords,
  resolveDefaultRecordsDirectory,
  sessionDirectoryName,
  updateSessionManifest,
} = require('./meeting-record-store');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-record-store-'));
}

function sampleMeta(overrides = {}) {
  return {
    sessionId: 'session-1',
    startedAt: Date.UTC(2026, 6, 30, 9, 30, 12),
    startedAtIso: '2026-07-30T09:30:12.000Z',
    endedAt: Date.UTC(2026, 6, 30, 9, 45, 0),
    appVersion: '0.1.0',
    glossaryConfigurationId: 'south-china-tooling',
    primaryProfile: 'economy',
    estimatedCostUsd: 0.12,
    channelAvailability: { microphone: true, system: true },
    ...overrides,
  };
}

test('resolves the documented default records directory', () => {
  const app = { getPath: (name) => (name === 'documents' ? '/Users/jqian/Documents' : '') };
  assert.equal(
    resolveDefaultRecordsDirectory(app),
    path.join('/Users/jqian/Documents', 'Twinscript'),
  );
});

test('formats the session directory name from the start time', () => {
  const startedAt = new Date(2026, 6, 30, 9, 30, 12).getTime();
  assert.equal(sessionDirectoryName(startedAt), '2026-07-30 09-30-12');
});

test('two sessions starting in the same second get disambiguated directories', () => {
  const root = tempRoot();
  const startedAt = new Date(2026, 6, 30, 9, 30, 12).getTime();
  const first = createSessionDirectory(root, startedAt);
  const second = createSessionDirectory(root, startedAt);
  const third = createSessionDirectory(root, startedAt);
  assert.notEqual(first, second);
  assert.notEqual(second, third);
  assert.equal(path.basename(second), '2026-07-30 09-30-12 (2)');
  assert.equal(path.basename(third), '2026-07-30 09-30-12 (3)');
});

test('appended transcript lines round-trip through readTranscriptRecords', async () => {
  const root = tempRoot();
  const sessionDir = createSessionDirectory(root, Date.now());
  await appendTranscriptRecord(sessionDir, {
    sessionId: 's1',
    sequence: 1,
    sourceChannel: 'microphone',
    sourceText: 'hello',
    english: 'hello',
    chinese: '你好',
  });
  await appendTranscriptRecord(sessionDir, {
    sessionId: 's1',
    sequence: 2,
    sourceChannel: 'system',
    sourceText: 'world',
    english: 'world',
    chinese: '世界',
  });

  const { records, truncated } = readTranscriptRecords(sessionDir);
  assert.equal(truncated, false);
  assert.equal(records.length, 2);
  assert.equal(records[0].sourceText, 'hello');
  assert.equal(records[1].sourceChannel, 'system');
});

test('a crash-truncated final transcript line is dropped, not thrown', () => {
  const root = tempRoot();
  const sessionDir = createSessionDirectory(root, Date.now());
  fs.writeFileSync(
    path.join(sessionDir, 'transcript.jsonl'),
    `${JSON.stringify({ sequence: 1, sourceText: 'complete' })}\n{"sequence":2,"sour`,
  );
  const { records, truncated } = readTranscriptRecords(sessionDir);
  assert.equal(truncated, true);
  assert.equal(records.length, 1);
  assert.equal(records[0].sourceText, 'complete');
});

test('a session with no transcript file reads as zero records', () => {
  const root = tempRoot();
  const sessionDir = createSessionDirectory(root, Date.now());
  assert.deepEqual(readTranscriptRecords(sessionDir), {
    records: [],
    truncated: false,
  });
});

test('finalize writes transcript.json, transcript.md, and session.json from the JSONL log', async () => {
  const root = tempRoot();
  const sessionDir = createSessionDirectory(root, Date.now());
  await appendTranscriptRecord(sessionDir, {
    sequence: 1,
    sourceChannel: 'microphone',
    sourceText: 'We need T2 by Friday.',
    english: 'We need T2 by Friday.',
    chinese: '我们星期五之前需要 T2。',
  });

  const { session } = finalizeTranscript(sessionDir, sampleMeta());

  const json = JSON.parse(fs.readFileSync(path.join(sessionDir, 'transcript.json'), 'utf8'));
  assert.equal(json.records.length, 1);
  assert.equal(json.sessionId, 'session-1');

  const markdown = fs.readFileSync(path.join(sessionDir, 'transcript.md'), 'utf8');
  assert.match(markdown, /YOU/);
  assert.match(markdown, /We need T2 by Friday\./);
  assert.match(markdown, /我们星期五之前需要 T2。/);

  assert.equal(session.captionCount, 1);
  assert.equal(session.audioRetention, 'pending');
  assert.equal(session.sessionId, 'session-1');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8')),
    session,
  );
});

test('finalize tolerates zero captions and still produces a manifest', () => {
  const root = tempRoot();
  const sessionDir = createSessionDirectory(root, Date.now());
  const { session, records } = finalizeTranscript(sessionDir, sampleMeta());
  assert.equal(records.length, 0);
  assert.equal(session.captionCount, 0);
  assert.equal(fs.existsSync(path.join(sessionDir, 'transcript.json')), true);
});

test('a caption containing a markdown table delimiter does not break the table', async () => {
  const root = tempRoot();
  const sessionDir = createSessionDirectory(root, Date.now());
  await appendTranscriptRecord(sessionDir, {
    sequence: 1,
    sourceChannel: 'microphone',
    sourceText: 'Use the | operator here.\nSecond line.',
    english: 'Use the | operator here.\nSecond line.',
    chinese: '在这里使用 | 运算符。',
  });
  finalizeTranscript(sessionDir, sampleMeta());
  const markdown = fs.readFileSync(path.join(sessionDir, 'transcript.md'), 'utf8');
  const rows = markdown.split('\n').filter((line) => line.startsWith('|'));
  // Header + separator + exactly one data row: the embedded "|" did not split
  // the caption into extra table cells/rows.
  assert.equal(rows.length, 3);
  assert.match(markdown, /Use the \\\| operator here\.<br>Second line\./);
});

test('finalize is idempotent: re-running after a partial crash reproduces the same output', async () => {
  const root = tempRoot();
  const sessionDir = createSessionDirectory(root, Date.now());
  await appendTranscriptRecord(sessionDir, {
    sequence: 1,
    sourceChannel: 'microphone',
    sourceText: 'one',
    english: 'one',
    chinese: '一',
  });
  const first = finalizeTranscript(sessionDir, sampleMeta());
  // Simulate a half-written transcript.json from an interrupted first attempt.
  fs.writeFileSync(path.join(sessionDir, 'transcript.json'), '{"records":[');
  const second = finalizeTranscript(sessionDir, sampleMeta());
  assert.deepEqual(second.session, first.session);
  const json = JSON.parse(fs.readFileSync(path.join(sessionDir, 'transcript.json'), 'utf8'));
  assert.equal(json.records.length, 1);
});

test('updateSessionManifest patches an existing manifest atomically', () => {
  const root = tempRoot();
  const sessionDir = createSessionDirectory(root, Date.now());
  finalizeTranscript(sessionDir, sampleMeta());

  const updated = updateSessionManifest(sessionDir, { audioRetention: 'kept' });
  assert.equal(updated.audioRetention, 'kept');
  assert.equal(readSessionManifest(sessionDir).audioRetention, 'kept');
  // Unrelated fields survive the patch.
  assert.equal(updated.sessionId, 'session-1');
});

test('updateSessionManifest on a session with no manifest yet is a safe no-op', () => {
  const root = tempRoot();
  const sessionDir = createSessionDirectory(root, Date.now());
  assert.equal(updateSessionManifest(sessionDir, { audioRetention: 'kept' }), null);
});

test('listSessions returns newest first and skips directories without a manifest', () => {
  const root = tempRoot();
  const older = createSessionDirectory(root, Date.now() - 60_000);
  finalizeTranscript(older, sampleMeta({ sessionId: 'older', startedAt: Date.now() - 60_000 }));
  const newer = createSessionDirectory(root, Date.now());
  finalizeTranscript(newer, sampleMeta({ sessionId: 'newer', startedAt: Date.now() }));
  fs.mkdirSync(path.join(root, 'not-a-session'));

  const sessions = listSessions(root);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].manifest.sessionId, 'newer');
  assert.equal(sessions[1].manifest.sessionId, 'older');
});

test('listSessions on a directory that does not exist yet returns empty, not an error', () => {
  assert.deepEqual(listSessions(path.join(tempRoot(), 'never-created')), []);
});

test('listPendingAudioDecisions only returns sessions still awaiting keep/discard', () => {
  const root = tempRoot();
  const pendingDir = createSessionDirectory(root, Date.now() - 1000);
  finalizeTranscript(pendingDir, sampleMeta({ sessionId: 'pending', startedAt: Date.now() - 1000 }));
  const keptDir = createSessionDirectory(root, Date.now());
  finalizeTranscript(keptDir, sampleMeta({ sessionId: 'kept', startedAt: Date.now() }));
  updateSessionManifest(keptDir, { audioRetention: 'kept' });

  const pending = listPendingAudioDecisions(root);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].manifest.sessionId, 'pending');
});
