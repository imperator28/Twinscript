'use strict';

// Is the DirectShow virtual camera installed?
//
// This replaces a byte-comparison of the Media Foundation host and media source,
// which reported "The installed camera does not match this app version. Choose
// Repair camera." whenever the packaged MF binaries changed. That was wrong twice
// over: the MF camera is not the shipping camera, and Repair would have installed
// the one that renders a black feed in every meeting client.
//
// A DirectShow capture filter is installed when two things are true, and reporting
// either half alone is how a camera comes to enumerate and then fail to activate:
//
//   1. the COM in-proc server registration exists and names a file that is present
//   2. the device-category entry exists, which is what puts it in a camera list
//
// Both live under HKLM, so this only ever reads - installation itself needs
// elevation and stays in scripts/register-dshow-camera.ps1.

const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');

const FILTER_CLSID = '{1F5A7C2E-8D64-4B93-9E11-3A6C5D8F27B4}';
const VIDEO_INPUT_CATEGORY = '{860BB310-5D01-11d0-BD3B-00A0C911CE86}';

/** Read a registry value, or null. `reg query` is used to avoid a native dep. */
function queryDefaultValue(keyPath, { run = spawnSync } = {}) {
  const result = run('reg', ['query', keyPath, '/ve'], {
    windowsHide: true,
    encoding: 'utf8',
  });
  if (!result || result.status !== 0 || !result.stdout) return null;
  // `(Default)    REG_SZ    C:\path\to.dll`
  const match = result.stdout.match(/REG_SZ\s+(.+?)\s*$/m);
  return match ? match[1].trim() : null;
}

/**
 * Does the category contain an entry whose CLSID is ours?
 *
 * Matched on the CLSID VALUE rather than the subkey name. IFilterMapper2 chooses
 * the instance key name, and assuming it equals the CLSID previously reported a
 * perfectly working registration as half-installed.
 */
function categoryEntryExists(clsid, { run = spawnSync } = {}) {
  const result = run(
    'reg',
    ['query', `HKLM\\SOFTWARE\\Classes\\CLSID\\${VIDEO_INPUT_CATEGORY}\\Instance`, '/s', '/v', 'CLSID'],
    { windowsHide: true, encoding: 'utf8' },
  );
  if (!result || result.status !== 0 || !result.stdout) return false;
  return result.stdout.toUpperCase().includes(clsid.toUpperCase());
}

/**
 * @returns {{installed: boolean, filterPath: string|null, reason: string|null}}
 */
function inspectDshowCamera({
  platform = process.platform,
  run = spawnSync,
  fileExists = existsSync,
  clsid = FILTER_CLSID,
} = {}) {
  if (platform !== 'win32') {
    return { installed: false, filterPath: null, reason: 'windows-only' };
  }

  const filterPath = queryDefaultValue(
    `HKLM\\SOFTWARE\\Classes\\CLSID\\${clsid}\\InprocServer32`,
    { run },
  );
  if (!filterPath) {
    return { installed: false, filterPath: null, reason: 'not-installed' };
  }
  if (!fileExists(filterPath)) {
    // Registered but the file is gone - a stale registration from a build that was
    // deleted. It enumerates and then fails to load, so it is worse than absent.
    return { installed: false, filterPath, reason: 'filter-file-missing' };
  }
  if (!categoryEntryExists(clsid, { run })) {
    return { installed: false, filterPath, reason: 'not-in-camera-list' };
  }
  return { installed: true, filterPath, reason: null };
}

/** Operator-facing text for each reason. */
function describeDshowCamera(inspection) {
  switch (inspection.reason) {
    case null:
      return null;
    case 'windows-only':
      return 'The virtual camera is available on Windows only.';
    case 'not-installed':
      return 'The virtual camera is not installed yet. Run Install camera once; it needs administrator approval.';
    case 'filter-file-missing':
      return 'The virtual camera is registered but its file is missing. Run Install camera to restore it.';
    case 'not-in-camera-list':
      return 'The virtual camera is registered but not listed as a capture device. Run Install camera to repair it.';
    default:
      return 'The virtual camera could not be verified.';
  }
}

module.exports = {
  FILTER_CLSID,
  VIDEO_INPUT_CATEGORY,
  categoryEntryExists,
  describeDshowCamera,
  inspectDshowCamera,
};
