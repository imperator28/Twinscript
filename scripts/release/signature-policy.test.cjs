'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SIGNATURE_TARGETS,
  STATUS_VERDICTS,
  buildSignatureReport,
  classifySignature,
  formatSignatureReport,
  targetFor,
} = require('./signature-policy.js');

const signed = (p, subject = 'CN=Example Publisher') => ({
  path: p, status: 'Valid', subject,
});
const unsigned = (p) => ({ path: p, status: 'NotSigned' });

// A release that verifies nothing must never report success. These are the
// cases that make the whole check worth having.

test('a fully signed release passes', () => {
  const report = buildSignatureReport({
    entries: [
      signed('TwinscriptSetup.exe'),
      signed('resources/app/twinscript.exe'),
      signed('resources/native-camera/vcam-host.exe'),
      signed('resources/native-camera/twinscript-vcam-source.dll'),
    ],
  });
  assert.equal(report.ok, true);
  assert.equal(report.counts.signed, 4);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.missing, []);
});

test('an empty scan fails instead of vacuously passing', () => {
  const report = buildSignatureReport({ entries: [] });
  assert.equal(report.ok, false);
  assert.equal(report.missing.length, 2, 'installer and app are required');
  assert.deepEqual(report.missing.map((m) => m.kind).sort(), ['app', 'installer']);
});

test('a missing installer fails even when everything present is signed', () => {
  const report = buildSignatureReport({
    entries: [signed('resources/app/twinscript.exe')],
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing.map((m) => m.kind), ['installer']);
});

test('an unsigned artifact fails a publishable release', () => {
  const report = buildSignatureReport({
    entries: [unsigned('TwinscriptSetup.exe'), signed('twinscript.exe')],
  });
  assert.equal(report.ok, false);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].kind, 'installer');
  assert.equal(report.failures[0].verdict, 'unsigned');
});

test('allowUnsigned tolerates unsigned but still reports it', () => {
  const report = buildSignatureReport({
    entries: [unsigned('TwinscriptSetup.exe'), unsigned('twinscript.exe')],
    allowUnsigned: true,
  });
  assert.equal(report.ok, true);
  assert.equal(report.allowUnsigned, true);
  assert.equal(report.counts.unsigned, 2);
  assert.equal(report.counts.waived, 2);
  assert.equal(report.counts.failed, 0);
  const text = formatSignatureReport(report);
  assert.match(text, /UNSIGNED INTERNAL BUILD/);
  // A waived line must not print FAIL next to a "0 failed" summary.
  assert.match(text, /^\s+WAIVE\s+installer\s+unsigned\s/m);
  assert.ok(!/FAIL/.test(text), 'waived entries must not read as failures');
});

test('an unsigned status carries no misleading execution-policy message', () => {
  const { detail } = classifySignature({
    status: 'NotSigned',
    statusMessage: 'The file ... is not digitally signed. You cannot run this script'
      + ' on the current system.',
  });
  assert.equal(detail, '');
});

test('allowUnsigned never waives a tampered artifact', () => {
  const report = buildSignatureReport({
    entries: [
      { path: 'TwinscriptSetup.exe', status: 'HashMismatch' },
      signed('twinscript.exe'),
    ],
    allowUnsigned: true,
  });
  assert.equal(report.ok, false);
  assert.equal(report.failures[0].verdict, 'tampered');
});

test('allowUnsigned never waives an untrusted root', () => {
  const report = buildSignatureReport({
    entries: [
      { path: 'TwinscriptSetup.exe', status: 'NotTrusted' },
      signed('twinscript.exe'),
    ],
    allowUnsigned: true,
  });
  assert.equal(report.ok, false);
  assert.equal(report.failures[0].verdict, 'untrusted-root');
});

test('every SignatureStatus enum member is mapped', () => {
  // The real System.Management.Automation.SignatureStatus members. An
  // unmapped one silently becomes 'error', which is safe but hides a typo —
  // this caught `notrusted` missing a t.
  const enumMembers = [
    'Valid', 'UnknownError', 'NotSigned', 'HashMismatch',
    'NotTrusted', 'NotSupportedFileFormat', 'Incompatible',
  ];
  for (const member of enumMembers) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(STATUS_VERDICTS, member.toLowerCase()),
      `SignatureStatus.${member} is not mapped in STATUS_VERDICTS`,
    );
  }
  assert.equal(Object.keys(STATUS_VERDICTS).length, enumMembers.length);
});

test('only Valid maps to signed', () => {
  const signedStatuses = Object.entries(STATUS_VERDICTS)
    .filter(([, verdict]) => verdict === 'signed')
    .map(([status]) => status);
  assert.deepEqual(signedStatuses, ['valid']);
});

test('an unrecognized status is an error, not a pass', () => {
  const report = buildSignatureReport({
    entries: [
      { path: 'TwinscriptSetup.exe', status: 'SomeFutureStatus' },
      signed('twinscript.exe'),
    ],
  });
  assert.equal(report.ok, false);
  assert.equal(report.failures[0].verdict, 'error');
  assert.match(report.failures[0].reason, /unrecognized status: SomeFutureStatus/);
});

test('a blank status is an error rather than treated as signed', () => {
  assert.equal(classifySignature({ status: '' }).verdict, 'error');
  assert.equal(classifySignature({}).verdict, 'error');
  assert.equal(classifySignature(null).verdict, 'error');
});

test('status matching is case-insensitive', () => {
  assert.equal(classifySignature({ status: 'valid' }).verdict, 'signed');
  assert.equal(classifySignature({ status: 'VALID' }).verdict, 'signed');
  assert.equal(classifySignature({ status: ' Valid ' }).verdict, 'signed');
});

test('an unexpected signing certificate fails', () => {
  const report = buildSignatureReport({
    entries: [
      signed('TwinscriptSetup.exe', 'CN=Someone Else, O=Other'),
      signed('twinscript.exe', 'CN=Real Publisher'),
    ],
    expectedSigners: ['CN=Real Publisher'],
  });
  assert.equal(report.ok, false);
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0].reason, /unexpected certificate/);
});

test('expectedSigners makes allowUnsigned inert, so a real release cannot be waived', () => {
  const report = buildSignatureReport({
    entries: [unsigned('TwinscriptSetup.exe'), signed('twinscript.exe')],
    allowUnsigned: true,
    expectedSigners: ['CN=Real Publisher'],
  });
  assert.equal(report.ok, false);
});

test('files that are not signature targets are ignored', () => {
  const report = buildSignatureReport({
    entries: [
      signed('TwinscriptSetup.exe'),
      signed('twinscript.exe'),
      unsigned('RELEASES'),
      unsigned('resources/app.asar'),
      unsigned('LICENSE.txt'),
    ],
  });
  assert.equal(report.ok, true);
  assert.equal(report.counts.inspected, 2);
});

test('targetFor recognizes Windows backslash paths', () => {
  assert.equal(targetFor('out\\make\\TwinscriptSetup.exe')?.kind, 'installer');
  assert.equal(
    targetFor('resources\\native-camera\\twinscript-vcam-source.dll')?.kind,
    'camera-source',
  );
  assert.equal(targetFor('resources\\app.asar'), null);
});

test('a nupkg-embedded exe path still matches the app target', () => {
  assert.equal(targetFor('lib/net45/twinscript.exe')?.kind, 'app');
});

test('every target declares a description and a kind', () => {
  for (const target of SIGNATURE_TARGETS) {
    assert.ok(target.kind, 'target needs a kind');
    assert.ok(target.description, `${target.kind} needs a description`);
    assert.equal(typeof target.required, 'boolean');
    assert.equal(typeof target.match, 'function');
  }
  const kinds = SIGNATURE_TARGETS.map((t) => t.kind);
  assert.equal(new Set(kinds).size, kinds.length, 'kinds must be unique');
});

test('the report formats a failure with its reason', () => {
  const report = buildSignatureReport({
    entries: [unsigned('TwinscriptSetup.exe'), signed('twinscript.exe')],
  });
  const text = formatSignatureReport(report);
  assert.match(text, /^\s+FAIL\s+installer\s+unsigned\s/m);
  assert.match(text, /^\s+OK\s+app\s+signed\s/m);
});
