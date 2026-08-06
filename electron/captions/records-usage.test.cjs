const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  countSessions,
  directoryBytes,
  summarizeRecordsUsage,
} = require('./records-usage');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'records-usage-'));
  const session = (name, bytes) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.json'), '{}');
    fs.writeFileSync(path.join(dir, 'audio.wav'), Buffer.alloc(bytes));
    return dir;
  };
  return { root, session };
}

test('sums file sizes recursively', () => {
  const { root, session } = fixture();
  session('2026-01-01', 1000);
  session('2026-01-02', 2000);
  // Two manifests of 2 bytes each plus the two payloads.
  assert.equal(directoryBytes(root), 3004);
});

test('returns zero for a directory that does not exist', () => {
  // A fresh install has written nothing yet; that is not an error condition.
  assert.equal(directoryBytes(path.join(os.tmpdir(), 'records-usage-absent')), 0);
});

test('counts only directories carrying a manifest', () => {
  const { root, session } = fixture();
  session('real-one', 10);
  fs.mkdirSync(path.join(root, 'half-created'));
  fs.writeFileSync(path.join(root, 'stray.txt'), 'x');
  // A half-created directory is not a meeting the operator would recognise.
  assert.equal(countSessions(root), 1);
});

test('summarizes records and pending audio separately', () => {
  const { root, session } = fixture();
  session('a', 500);
  const pending = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-'));
  fs.writeFileSync(path.join(pending, 'chunk.bin'), Buffer.alloc(4096));

  const usage = summarizeRecordsUsage({ recordsRoot: root, pendingRoot: pending });
  assert.equal(usage.sessionCount, 1);
  assert.equal(usage.bytes, 502);
  // Reported alongside, not folded in: this is the part the operator can still
  // release by answering the prompt.
  assert.equal(usage.pendingBytes, 4096);
});

test('handles missing roots without throwing', () => {
  assert.deepEqual(summarizeRecordsUsage({}), {
    bytes: 0,
    sessionCount: 0,
    pendingBytes: 0,
  });
});

test('skips unreadable entries instead of failing the whole readout', () => {
  // A usage number must never be the thing that breaks the Settings tab.
  const fileSystem = {
    readdirSync: (dir) => {
      if (dir === 'root') {
        return [
          { name: 'ok.bin', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
          { name: 'locked.bin', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
        ];
      }
      throw new Error('EACCES');
    },
    lstatSync: (target) => {
      if (target.endsWith('locked.bin')) throw new Error('EACCES');
      return { size: 64 };
    },
    existsSync: () => false,
  };
  assert.equal(directoryBytes('root', { fileSystem }), 64);
});

test('counts a symlink by its own size rather than following it', () => {
  // Following would attribute a target outside the records tree to it, and a cycle
  // would never terminate.
  const fileSystem = {
    readdirSync: () => [
      { name: 'link', isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true },
    ],
    lstatSync: () => ({ size: 12 }),
    existsSync: () => false,
  };
  assert.equal(directoryBytes('root', { fileSystem }), 12);
});
