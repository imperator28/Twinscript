// Structural checks on register-dshow-camera.ps1.
//
// PowerShell cannot be executed from these tests, and the properties below are
// exactly the ones that broke in practice: the app spawns this script with its own
// non-elevated token, so a script that merely *checks* for administrator can never
// succeed from the UI. That regression surfaced to the operator as
// "Native camera action failed (exit 2)" with no way forward, and nothing in the
// suite noticed - the Node side was fully covered and completely correct.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SCRIPT_PATH = path.join(
  __dirname,
  '..',
  '..',
  'scripts',
  'register-dshow-camera.ps1',
);
const script = fs.readFileSync(SCRIPT_PATH, 'utf8');

test('the script requests elevation instead of only requiring it', () => {
  assert.match(
    script,
    /Start-Process[\s\S]{0,200}-Verb RunAs/,
    'Install and Remove write under HKEY_CLASSES_ROOT, so they need administrator. ' +
      'The app cannot supply that, so the script must request it itself.',
  );
});

test('the relaunch is guarded so it cannot recurse forever', () => {
  assert.match(script, /\[switch\]\$Elevated/);
  assert.match(script, /-not \$isAdmin -and -not \$Elevated/);
  // The child must actually be told it is the elevated copy.
  assert.match(script, /-Elevated/);
});

test('a canceled UAC prompt is reported as 1223, not as a generic failure', () => {
  // The installer maps 1223 to "Windows approval was canceled", which is a
  // different thing to a user than "failed".
  assert.match(script, /NativeErrorCode -eq 1223/);
  assert.match(script, /exit 1223/);
});

test('Status is read-only and never triggers a UAC prompt', () => {
  const statusExit = script.indexOf("if ($Action -eq 'Status')");
  const elevation = script.indexOf('-Verb RunAs');
  assert.ok(statusExit > 0, 'expected a Status branch');
  assert.ok(elevation > 0, 'expected an elevation branch');
  assert.ok(
    statusExit < elevation,
    'Status must exit before the elevation branch: inspecting the registry needs ' +
      'no administrator, and the app polls it for health.',
  );
});

test('Remove does not require the built filter to still exist', () => {
  // Removal unregisters through the path recorded in the registry. Requiring the
  // built DLL would leave a machine whose DLL is already gone permanently
  // registered, with no way to clean up.
  assert.match(
    script,
    /\$Action -eq 'Install' -and -not \(Test-Path -LiteralPath \$builtDll\)/,
  );
});

test('every path handed to the elevated child is quoted', () => {
  // The development ReleaseDir is under "Documents\Bilingual Meeting", which
  // contains a space; an unquoted argument silently truncates at it.
  const match = script.match(/\$childArgs = '([^']+)'/);
  assert.ok(match, 'expected the child argument string');
  assert.match(match[1], /-File "\{0\}"/);
  assert.match(match[1], /-ReleaseDir "\{2\}"/);
});
