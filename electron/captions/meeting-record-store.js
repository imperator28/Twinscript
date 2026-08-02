const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The user-visible half of a meeting record: one directory per session under
// the user-chosen records folder, holding the transcript in three formats and
// a session manifest. Encrypted temporary audio lives elsewhere (see
// `recording-key-store.js` / `encrypted-audio-writer.js`) and is folded in
// here only once the operator decides to keep it (see `wav-finalizer.js`).
//
// `transcript.jsonl` is the crash-safe source of truth: every finalized
// caption is appended as one line the moment it is available, so a crash mid
// meeting loses at most the interrupted line. `transcript.json`/`.md` and
// `session.json` are derived, atomically-written snapshots produced at stop
// (or recovery) by replaying the JSONL.

const RECORD_FORMAT_VERSION = 1;

function atomicWrite(filePath, contents, options) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, contents, options);
  fs.renameSync(temporary, filePath);
}

function resolveDefaultRecordsDirectory(app) {
  return path.join(app.getPath('documents'), 'Bilingual Meeting Captions');
}

/** `YYYY-MM-DD HH-mm-ss`, filesystem-safe on Windows, macOS, and Linux. */
function sessionDirectoryName(startedAt) {
  const date = new Date(startedAt);
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/** Create `<rootDir>/<timestamp>`, disambiguating same-second collisions. */
function createSessionDirectory(rootDir, startedAt) {
  fs.mkdirSync(rootDir, { recursive: true });
  const base = sessionDirectoryName(startedAt);
  let candidate = base;
  let suffix = 2;
  while (fs.existsSync(path.join(rootDir, candidate))) {
    candidate = `${base} (${suffix})`;
    suffix += 1;
  }
  const sessionDir = path.join(rootDir, candidate);
  fs.mkdirSync(sessionDir);
  return sessionDir;
}

function transcriptPath(sessionDir) {
  return path.join(sessionDir, 'transcript.jsonl');
}

/**
 * Append one finalized caption to the crash-safe transcript log.
 *
 * Fire-and-forget from the caller's perspective (returns the write promise
 * for tests, but a caption session must not block live captioning on disk
 * I/O): callers that care about ordering should await the returned promise
 * before finalizing.
 */
function appendTranscriptRecord(sessionDir, record) {
  const line = `${JSON.stringify({ version: RECORD_FORMAT_VERSION, ...record })}\n`;
  return fs.promises.appendFile(transcriptPath(sessionDir), line, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/**
 * Read every valid transcript line, tolerating a crash-truncated final line —
 * the same interrupted-append artifact `wav-finalizer.js` tolerates in the
 * encrypted audio stream.
 */
function readTranscriptRecords(sessionDir) {
  const filePath = transcriptPath(sessionDir);
  if (!fs.existsSync(filePath)) return { records: [], truncated: false };
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const records = [];
  let truncated = false;
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      truncated = true;
      break;
    }
  }
  return { records, truncated };
}

function escapeMarkdownCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function renderMarkdown({ records, session }) {
  const lines = [
    `# Bilingual meeting captions — ${session.startedAtIso}`,
    '',
    `Session ID: \`${session.sessionId}\``,
    '',
    '| Speaker | Original | English | Chinese |',
    '| --- | --- | --- | --- |',
  ];
  for (const record of records) {
    const speaker = record.sourceChannel === 'microphone' ? 'YOU' : 'MEETING';
    lines.push(
      `| ${speaker} | ${escapeMarkdownCell(record.sourceText)} | ` +
        `${escapeMarkdownCell(record.english)} | ${escapeMarkdownCell(record.chinese)} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function writeSessionManifest(
  sessionDir,
  sessionMeta,
  { captionCount = 0, transcriptTruncated = false } = {},
) {
  const session = {
    version: RECORD_FORMAT_VERSION,
    sessionId: sessionMeta.sessionId,
    startedAt: sessionMeta.startedAt,
    startedAtIso: sessionMeta.startedAtIso,
    endedAt: sessionMeta.endedAt,
    appVersion: sessionMeta.appVersion,
    glossaryConfigurationId: sessionMeta.glossaryConfigurationId,
    primaryProfile: sessionMeta.primaryProfile,
    estimatedCostUsd: sessionMeta.estimatedCostUsd,
    channelAvailability: sessionMeta.channelAvailability,
    captionCount,
    transcriptTruncated,
    transcriptSaved: captionCount > 0 || Boolean(sessionMeta.transcriptSaved),
    audioRetention: sessionMeta.audioRetention || 'pending',
    audioTracks: sessionMeta.audioTracks || null,
  };
  atomicWrite(
    path.join(sessionDir, 'session.json'),
    JSON.stringify(session, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  );
  return session;
}

/**
 * Replay `transcript.jsonl` into the three finalized artifacts. Idempotent:
 * calling this again (e.g. during crash recovery) re-derives the same output
 * from the same source lines and overwrites the previous snapshot atomically,
 * so a partially-written finalize from an earlier crash is never left as the
 * visible result.
 *
 * `sessionMeta` carries the facts the JSONL stream does not: timestamps,
 * channel availability, configuration, and cost. `audioRetention` defaults to
 * `'pending'` — the caller updates it later via `updateSessionAudioState`.
 */
function finalizeTranscript(sessionDir, sessionMeta) {
  const { records, truncated } = readTranscriptRecords(sessionDir);

  atomicWrite(
    path.join(sessionDir, 'transcript.json'),
    JSON.stringify(
      { version: RECORD_FORMAT_VERSION, sessionId: sessionMeta.sessionId, records },
      null,
      2,
    ),
    { encoding: 'utf8', mode: 0o600 },
  );
  atomicWrite(
    path.join(sessionDir, 'transcript.md'),
    renderMarkdown({ records, session: sessionMeta }),
    { encoding: 'utf8', mode: 0o600 },
  );

  const session = writeSessionManifest(
    sessionDir,
    { ...sessionMeta, transcriptSaved: true },
    { captionCount: records.length, transcriptTruncated: truncated },
  );
  return { records, truncated, session };
}

function readSessionManifest(sessionDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Merge a patch into `session.json` (e.g. the outcome of Keep or Discard),
 * atomically. Returns `null` if the session has no manifest yet (finalize
 * has not run — nothing to patch).
 */
function updateSessionManifest(sessionDir, patch) {
  const current = readSessionManifest(sessionDir);
  if (!current) return null;
  const next = { ...current, ...patch };
  atomicWrite(
    path.join(sessionDir, 'session.json'),
    JSON.stringify(next, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  );
  return next;
}

/** Every session with a manifest, newest first. */
function listSessions(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  return fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const sessionDir = path.join(rootDir, entry.name);
      const manifest = readSessionManifest(sessionDir);
      return manifest && { sessionDir, manifest };
    })
    .filter(Boolean)
    .sort((left, right) => right.manifest.startedAt - left.manifest.startedAt);
}

/** Sessions whose audio keep/discard decision has not been made yet. */
function listPendingAudioDecisions(rootDir) {
  return listSessions(rootDir).filter(
    (entry) => entry.manifest.audioRetention === 'pending',
  );
}

module.exports = {
  RECORD_FORMAT_VERSION,
  resolveDefaultRecordsDirectory,
  sessionDirectoryName,
  createSessionDirectory,
  appendTranscriptRecord,
  readTranscriptRecords,
  finalizeTranscript,
  writeSessionManifest,
  readSessionManifest,
  updateSessionManifest,
  listSessions,
  listPendingAudioDecisions,
};
