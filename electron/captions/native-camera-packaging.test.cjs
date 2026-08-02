const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Windows packages stage the host, source DLL, and lifecycle scripts together', () => {
  const forge = read('forge.config.js');
  assert.match(forge, /WINDOWS_NATIVE_CAMERA_RESOURCES/);
  assert.match(forge, /'native', 'camera-companion', 'build', 'Release'/);
  assert.match(forge, /vcam-host\.exe/);
  assert.match(forge, /twinscript-vcam-source\.dll/);
  assert.match(forge, /install-native-camera\.ps1/);
  assert.match(forge, /uninstall-native-camera\.ps1/);
  assert.match(forge, /path\.resolve\(buildPath, '\.\.', 'native-camera'\)/);
  assert.match(forge, /stageNativeCameraResources\(buildPath, platform\)/);
});

test('registration scripts use one verified ProgramData target and idempotent commands', () => {
  const install = read('scripts/install-native-camera.ps1');
  const uninstall = read('scripts/uninstall-native-camera.ps1');
  for (const script of [install, uninstall]) {
    assert.match(script, /ProgramData/);
    assert.match(script, /Twinscript/);
    assert.match(script, /GetFullPath/);
    assert.match(script, /OrdinalIgnoreCase/);
    assert.match(script, /-Verb RunAs/);
  }
  assert.match(install, /\$registrationRoot/);
  assert.doesNotMatch(install, /& \$installedHost unregister-machine/);
  assert.match(install, /register-machine/);
  assert.match(install, /status-machine/);
  assert.match(uninstall, /\$registrationRoot/);
  assert.match(uninstall, /6B8F2C4A-9D3E-4A17-8C25-1E7B4F6D9A03/);
  assert.match(uninstall, /Remove-Item -LiteralPath \$installRoot -Recurse -Force/);
});

test('native camera installation accepts Windows account and Microsoft account SIDs', () => {
  const install = read('scripts/install-native-camera.ps1');
  assert.match(install, /SecurityIdentifier/);
  assert.doesNotMatch(install, /\^S-1-5-/);
});

test('machine binaries stay administrator-owned while only runtime data is user-writable', () => {
  const install = read('scripts/install-native-camera.ps1');
  assert.match(install, /\$runtimeRoot = Join-Path \$installRoot 'runtime'/);
  assert.match(install, /\*S-1-5-18:\(OI\)\(CI\)F/);
  assert.match(install, /\*S-1-5-32-544:\(OI\)\(CI\)F/);
  assert.match(install, /\*S-1-5-19:\(OI\)\(CI\)RX/);
  assert.doesNotMatch(
    install,
    /icacls\.exe \$installRoot[^\r\n]*\$\{UserSid\}:\(OI\)\(CI\)M/,
  );
  assert.match(
    install,
    /icacls\.exe \$runtimeRoot[^\r\n]*\*\$\{UserSid\}:\(OI\)\(CI\)M/,
  );
});

test('the installer accepts an Entra ID account SID, not only NT authority', () => {
  const install = read('scripts/install-native-camera.ps1');
  const match = install.match(/if \(\$UserSid -notmatch '([^']+)'\)/);
  assert.ok(match, 'the installer must validate the requesting user SID');
  const pattern = new RegExp(match[1]);

  // An Entra ID (Azure AD) account has identifier authority 12. Corporate
  // Windows machines are routinely Entra-joined, so an S-1-5-only pattern
  // rejects the ordinary case and the install fails with a bare "exit 1".
  assert.ok(
    pattern.test('S-1-12-1-3119609239-1254419871-2813377684-3969048478'),
    'an Entra ID user SID must be accepted',
  );
  // Local and domain accounts must keep working.
  assert.ok(pattern.test('S-1-5-21-1004336348-1177238915-682003330-512'));
  assert.ok(pattern.test('S-1-5-18'));

  // The SID reaches an icacls command line, so it must still be constrained.
  for (const hostile of [
    'S-1-5-21-1 /grant:r Everyone:(OI)(CI)F',
    'S-1-5-21-1"; rm -rf /',
    'S-1-5-21-1 & calc.exe',
    'Everyone',
    '',
  ]) {
    assert.equal(pattern.test(hostile), false, `must reject: ${hostile}`);
  }

  // A shape check alone is weak; the script also parses it as a real SID.
  assert.match(install, /\[Security\.Principal\.SecurityIdentifier\]::new\(\$UserSid\)/);
});

test('COM unloadability accounts for every live camera object', () => {
  const dll = read('native/camera-companion/src/source/dll_main.cpp');
  const source = read('native/camera-companion/src/source/media_source.cpp');
  const stream = read('native/camera-companion/src/source/media_stream.cpp');
  const activate = read('native/camera-companion/src/source/media_source_activate.h');
  assert.match(dll, /g_object_count/);
  assert.match(dll, /g_object_count == 0 && g_lock_count == 0/);
  for (const code of [dll, source, stream, activate]) {
    assert.match(code, /ModuleObjectCreated\(\)/);
    assert.match(code, /ModuleObjectDestroyed\(\)/);
  }
});

test('the shipped camera CLSID remains the documented stable identifier', () => {
  const guids = read('native/camera-companion/src/source/vcam_guids.h');
  assert.match(guids, /\{6B8F2C4A-9D3E-4A17-8C25-1E7B4F6D9A03\}/);
  assert.match(guids, /must never change once a build has/);
});
