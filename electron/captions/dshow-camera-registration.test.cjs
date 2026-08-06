'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FILTER_CLSID,
  describeDshowCamera,
  inspectDshowCamera,
} = require('./dshow-camera-registration.js');

const DLL = 'C:\\ProgramData\\Twinscript\\bin\\twinscript-dshow-camera-1.dll';

/** Fake `reg query` covering the two keys the inspection reads. */
function fakeReg({ filterPath = DLL, inCategory = true } = {}) {
  return (command, args) => {
    const key = args[1] || '';
    if (key.includes('InprocServer32')) {
      if (!filterPath) return { status: 1, stdout: '' };
      return { status: 0, stdout: `\n    (Default)    REG_SZ    ${filterPath}\n` };
    }
    if (key.includes('Instance')) {
      return inCategory
        ? { status: 0, stdout: `\n    CLSID    REG_SZ    ${FILTER_CLSID}\n` }
        : { status: 0, stdout: '\n    CLSID    REG_SZ    {OTHER-CAMERA}\n' };
    }
    return { status: 1, stdout: '' };
  };
}

test('a fully installed filter reports installed with its path', () => {
  const result = inspectDshowCamera({
    platform: 'win32',
    run: fakeReg(),
    fileExists: () => true,
  });
  assert.deepEqual(result, { installed: true, filterPath: DLL, reason: null });
  assert.equal(describeDshowCamera(result), null, 'nothing to tell the operator');
});

test('an absent registration reports not-installed', () => {
  const result = inspectDshowCamera({
    platform: 'win32',
    run: fakeReg({ filterPath: null }),
    fileExists: () => true,
  });
  assert.equal(result.installed, false);
  assert.equal(result.reason, 'not-installed');
  assert.match(describeDshowCamera(result), /needs administrator approval/);
});

test('a registration pointing at a deleted file is not installed', () => {
  // Worse than absent: it enumerates and then fails to load, so it must not be
  // reported as healthy.
  const result = inspectDshowCamera({
    platform: 'win32',
    run: fakeReg(),
    fileExists: () => false,
  });
  assert.equal(result.installed, false);
  assert.equal(result.reason, 'filter-file-missing');
  assert.match(describeDshowCamera(result), /file is missing/);
});

test('a COM server without a category entry is not installed', () => {
  // This is the half-registered state: activatable but not in any camera list.
  const result = inspectDshowCamera({
    platform: 'win32',
    run: fakeReg({ inCategory: false }),
    fileExists: () => true,
  });
  assert.equal(result.installed, false);
  assert.equal(result.reason, 'not-in-camera-list');
});

test('the category is matched on the CLSID value, not the key name', () => {
  // IFilterMapper2 picks the instance key name. Assuming it equals the CLSID once
  // reported a working registration as half-installed.
  const run = (command, args) => {
    const key = args[1] || '';
    if (key.includes('InprocServer32')) {
      return { status: 0, stdout: `(Default)    REG_SZ    ${DLL}` };
    }
    return {
      status: 0,
      stdout: `HKEY_LOCAL_MACHINE\\...\\Instance\\Twinscript\n    CLSID    REG_SZ    ${FILTER_CLSID.toLowerCase()}\n`,
    };
  };
  const result = inspectDshowCamera({ platform: 'win32', run, fileExists: () => true });
  assert.equal(result.installed, true, 'case and key name must not matter');
});

test('non-Windows reports unsupported without touching the registry', () => {
  let called = false;
  const result = inspectDshowCamera({
    platform: 'darwin',
    run: () => {
      called = true;
      return { status: 1, stdout: '' };
    },
  });
  assert.equal(result.installed, false);
  assert.equal(result.reason, 'windows-only');
  assert.equal(called, false);
});

test('a failing reg query is treated as not installed, never as installed', () => {
  const result = inspectDshowCamera({
    platform: 'win32',
    run: () => ({ status: 1, stdout: '' }),
    fileExists: () => true,
  });
  assert.equal(result.installed, false);
});

test('every reason has operator-facing text', () => {
  for (const reason of [
    'windows-only',
    'not-installed',
    'filter-file-missing',
    'not-in-camera-list',
  ]) {
    const message = describeDshowCamera({ reason });
    assert.ok(message && message.length > 20, `${reason} needs a usable message`);
    // Never advise Repair: on this app that button installs the Media Foundation
    // camera, which renders a black feed.
    assert.doesNotMatch(message, /Repair camera/);
  }
});
