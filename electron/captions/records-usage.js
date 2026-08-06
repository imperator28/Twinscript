const fs = require('fs');
const path = require('path');

/**
 * How much disk the meeting records are actually using.
 *
 * The Settings card only ever stated a hypothetical - "two retained one-hour tracks can
 * use approximately 346 MB" - which tells an operator nothing about the meetings they
 * have. Undecided audio in particular now ages out at five recordings, and the only
 * honest way to show what that cap is holding back is to measure it.
 *
 * `fs` is injected so this is testable against a fixture tree without mocking modules.
 */

/**
 * Total bytes of every regular file under `dir`, recursively.
 *
 * Symlinks are counted by their own size rather than followed: a link pointing outside
 * the records tree would otherwise be attributed to it, and a link cycle would not
 * terminate. Unreadable entries are skipped instead of throwing, because a usage
 * readout must never be the thing that breaks the Settings tab.
 */
function directoryBytes(dir, { fileSystem = fs } = {}) {
  let total = 0;
  let entries;
  try {
    entries = fileSystem.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += directoryBytes(target, { fileSystem });
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        total += fileSystem.lstatSync(target).size;
      }
    } catch {
      // A file removed or locked between readdir and lstat contributes nothing.
    }
  }
  return total;
}

/** Immediate subdirectories that look like a saved session (they carry a manifest). */
function countSessions(rootDir, { fileSystem = fs } = {}) {
  let entries;
  try {
    entries = fileSystem.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  return entries.filter((entry) => {
    if (!entry.isDirectory()) return false;
    // Counting manifests rather than directories: a half-created session directory is
    // not a meeting the operator would recognise in the list.
    return fileSystem.existsSync(path.join(rootDir, entry.name, 'session.json'));
  }).length;
}

/**
 * @returns {{bytes: number, sessionCount: number, pendingBytes: number}}
 *   `bytes` covers the visible records tree; `pendingBytes` is the encrypted audio in
 *   the separate pending directory, reported alongside rather than folded in, because
 *   that is the part the operator can still release by answering the prompt.
 */
function summarizeRecordsUsage(
  { recordsRoot, pendingRoot },
  { fileSystem = fs } = {},
) {
  return {
    bytes: recordsRoot ? directoryBytes(recordsRoot, { fileSystem }) : 0,
    sessionCount: recordsRoot ? countSessions(recordsRoot, { fileSystem }) : 0,
    pendingBytes: pendingRoot ? directoryBytes(pendingRoot, { fileSystem }) : 0,
  };
}

module.exports = { directoryBytes, countSessions, summarizeRecordsUsage };
