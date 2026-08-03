'use strict';

// Which Windows release artifacts must carry a valid Authenticode signature,
// and how to read `Get-AuthenticodeSignature` output.
//
// This is separated from the script that shells out to PowerShell so the policy
// itself is testable. The failure mode this guards against is a release that
// *looks* verified because every check silently passed over a file that was
// never inspected, or a status string nobody mapped.

/**
 * Artifacts that must be signed before publishing, as glob-free suffix rules
 * matched against a path relative to the scanned root.
 *
 * `kind` groups them for the report; `required` distinguishes "must exist and
 * must be signed" from "sign it if present". The native camera companion is
 * `required: false` because a build that omits the native camera is still a
 * valid release — but if it ships, it is loaded into other processes by the
 * Windows Frame Server and must be signed.
 */
const SIGNATURE_TARGETS = Object.freeze([
  Object.freeze({
    kind: 'installer',
    description: 'Squirrel setup executable',
    required: true,
    match: (rel) => /(^|\/)[^/]*Setup[^/]*\.exe$/i.test(rel),
  }),
  Object.freeze({
    kind: 'app',
    description: 'Application executable',
    required: true,
    match: (rel) => /(^|\/)twinscript\.exe$/i.test(rel),
  }),
  Object.freeze({
    kind: 'camera-host',
    description: 'Native camera companion host',
    required: false,
    match: (rel) => /(^|\/)vcam-host\.exe$/i.test(rel),
  }),
  Object.freeze({
    kind: 'camera-source',
    description: 'Native camera media source (loaded by the Frame Server)',
    required: false,
    match: (rel) => /(^|\/)twinscript-vcam-source\.dll$/i.test(rel),
  }),
]);

// The complete System.Management.Automation.SignatureStatus enum, mapped to a
// verdict. Anything not listed is treated as a failure rather than assumed
// benign — an unrecognized status must never read as "fine".
const STATUS_VERDICTS = Object.freeze({
  valid: 'signed',
  notsigned: 'unsigned',
  hashmismatch: 'tampered',
  nottrusted: 'untrusted-root',
  unknownerror: 'error',
  incompatible: 'error',
  notsupportedfileformat: 'unsupported',
});

/** Normalize one PowerShell signature record into a verdict. */
function classifySignature(record) {
  const raw = String(record?.status ?? '').trim().toLowerCase();
  if (!raw) return { verdict: 'error', detail: 'no status reported' };
  const verdict = STATUS_VERDICTS[raw] ?? 'error';
  let detail;
  if (!STATUS_VERDICTS[raw]) {
    detail = `unrecognized status: ${record.status}`;
  } else if (verdict === 'unsigned') {
    // Windows returns a message about script execution policy here, which is
    // irrelevant and actively confusing for a DLL. "unsigned" is the whole fact.
    detail = '';
  } else {
    detail = String(record?.statusMessage ?? '').trim();
  }
  return { verdict, detail, subject: record?.subject ?? null };
}

/** The target rule a relative path falls under, or null if it is not a target. */
function targetFor(relativePath) {
  const rel = String(relativePath || '').split('\\').join('/');
  return SIGNATURE_TARGETS.find((target) => target.match(rel)) ?? null;
}

/**
 * Decide whether a set of inspected files satisfies the release policy.
 *
 * @param {object} options
 * @param {Array<{path: string, status: string, statusMessage?: string, subject?: string}>} options.entries
 *   One record per inspected file, paths relative to the scanned root.
 * @param {boolean} [options.allowUnsigned]
 *   When true, unsigned artifacts are reported but do not fail. Reserved for an
 *   explicitly-marked internal build; a published release must never set it.
 * @param {string[]} [options.expectedSigners]
 *   If given, a signed file whose certificate subject matches none of these
 *   fails. Guards against a release signed by the wrong certificate.
 */
function buildSignatureReport({ entries, allowUnsigned = false, expectedSigners = [] } = {}) {
  const inspected = [];
  const failures = [];
  const seenKinds = new Set();

  for (const entry of entries || []) {
    const target = targetFor(entry.path);
    if (!target) continue; // not a signature target; ignored by design
    const { verdict, detail, subject } = classifySignature(entry);
    seenKinds.add(target.kind);

    let ok = verdict === 'signed';
    let reason = ok ? '' : `${verdict}${detail ? `: ${detail}` : ''}`;

    if (ok && expectedSigners.length) {
      const matched = expectedSigners.some(
        (signer) => String(subject || '').toLowerCase().includes(signer.toLowerCase()),
      );
      if (!matched) {
        ok = false;
        reason = `signed by an unexpected certificate: ${subject || 'unknown'}`;
      }
    }

    // An unsigned artifact is tolerable only under an explicit internal-build
    // flag. Tampering and an unexpected signer never are: those indicate the
    // artifact is not what it claims to be, which no flag should wave through.
    const waived = !ok
      && verdict === 'unsigned'
      && allowUnsigned
      && expectedSigners.length === 0;

    const record = {
      path: entry.path,
      kind: target.kind,
      verdict,
      subject: subject ?? null,
      ok,
      waived,
      reason,
    };
    inspected.push(record);
    if (!ok && !waived) failures.push(record);
  }

  // A target that was never inspected is the dangerous case: zero failures
  // because zero files were checked.
  const missing = SIGNATURE_TARGETS
    .filter((target) => target.required && !seenKinds.has(target.kind))
    .map((target) => ({
      kind: target.kind,
      reason: `no ${target.description} was found to verify`,
    }));

  return {
    ok: failures.length === 0 && missing.length === 0,
    allowUnsigned,
    inspected,
    failures,
    missing,
    counts: {
      inspected: inspected.length,
      signed: inspected.filter((r) => r.verdict === 'signed').length,
      unsigned: inspected.filter((r) => r.verdict === 'unsigned').length,
      waived: inspected.filter((r) => r.waived).length,
      failed: failures.length,
    },
  };
}

/** Human-readable lines for CI output. */
function formatSignatureReport(report) {
  const lines = [];
  for (const record of report.inspected) {
    // WAIVE must read differently from FAIL: a line marked FAIL alongside a
    // "0 failed" summary reads as a broken report.
    const label = record.ok ? 'OK  ' : record.waived ? 'WAIVE' : 'FAIL';
    lines.push(
      `  ${label.padEnd(5)} ${record.kind.padEnd(14)} `
      + `${record.verdict.padEnd(15)} ${record.path}`
      + (record.reason && !record.waived ? `\n         ${record.reason}` : ''),
    );
  }
  for (const gap of report.missing) {
    lines.push(`  FAIL  ${gap.kind.padEnd(14)} ${gap.reason}`);
  }
  if (!report.inspected.length && !report.missing.length) {
    lines.push('  no signature targets were found');
  }
  lines.push('');
  lines.push(
    `  ${report.counts.inspected} inspected, ${report.counts.signed} signed, `
    + `${report.counts.unsigned} unsigned, ${report.counts.waived} waived, `
    + `${report.counts.failed} failed`,
  );
  if (report.allowUnsigned) {
    lines.push('  UNSIGNED INTERNAL BUILD — not publishable.');
  }
  return lines.join('\n');
}

module.exports = {
  SIGNATURE_TARGETS,
  STATUS_VERDICTS,
  buildSignatureReport,
  classifySignature,
  formatSignatureReport,
  targetFor,
};
