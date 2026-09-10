// Verify Authenticode signatures on the Windows release artifacts.
//
// The decision logic lives in scripts/release/signature-policy.js and is unit
// tested; this file is the glue that finds candidate files and asks Windows
// about them. Keeping the split means the interesting failure modes — an empty
// scan reporting success, an unmapped status reading as fine — are covered by
// tests rather than only by running a release.
//
// Usage:
//   node scripts/verify-windows-signatures.mjs out/make/squirrel.windows/x64
//   node scripts/verify-windows-signatures.mjs out --allow-unsigned
//   node scripts/verify-windows-signatures.mjs out --expect-signer "CN=Acme Inc"
//
// Exits 0 when the policy is satisfied, 1 when it is not, 2 on a usage or
// environment error. `--allow-unsigned` is for an explicitly internal build and
// is refused together with --expect-signer, so a real release cannot be waived.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildSignatureReport,
  formatSignatureReport,
  targetFor,
} = require('./release/signature-policy.js');

const SIGNABLE_EXTENSIONS = new Set(['.exe', '.dll']);

function parseArgs(argv) {
  const args = { root: '', allowUnsigned: false, expectedSigners: [], json: '' };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--allow-unsigned') args.allowUnsigned = true;
    else if (token === '--expect-signer') args.expectedSigners.push(argv[++i]);
    else if (token === '--json') args.json = argv[++i];
    else if (token.startsWith('--')) throw new Error(`unknown flag: ${token}`);
    else if (!args.root) args.root = token;
    else throw new Error(`unexpected argument: ${token}`);
  }
  return args;
}

/** Every signable file under `root`, as paths relative to it. */
function findCandidates(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (SIGNABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(path.relative(root, absolute).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return found;
}

/**
 * Ask Windows for the signature status of each path, in one PowerShell call.
 *
 * Paths are passed on stdin rather than the command line so a path containing a
 * quote or a bracket cannot alter the script being run.
 */
function inspectSignatures(root, relativePaths) {
  if (!relativePaths.length) return [];
  const script = `
    $ErrorActionPreference = 'Stop'
    # Windows PowerShell only. It finds Get-AuthenticodeSignature by autoloading
    # Microsoft.PowerShell.Security from PSModulePath, and a GitHub Actions
    # runner rewrites that variable for PowerShell 7 - so 5.1 cannot find its
    # own modules and the command fails with "the module could not be loaded".
    #
    # Guarded on the edition because doing this in PowerShell 7 breaks it the
    # other way: with the 5.1 module directory on the path, 7 imports that
    # module through Windows PowerShell compatibility and fails with "all of the
    # requested remote commands would shadow existing local commands". 7 already
    # ships the cmdlet, so it needs neither the path nor the import.
    if ($PSVersionTable.PSEdition -eq 'Desktop') {
      $systemModules = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\Modules'
      if (Test-Path -LiteralPath $systemModules) {
        $env:PSModulePath = $systemModules + ';' + $env:PSModulePath
      }
      Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
    }
    # $input is a one-shot enumerator: materialize it once, or reading the root
    # line would consume the whole pipeline and leave no paths to inspect.
    $lines = @($input)
    $root = $lines[0]
    $records = @()
    foreach ($line in @($lines | Select-Object -Skip 1)) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      $full = Join-Path $root $line
      $sig = Get-AuthenticodeSignature -LiteralPath $full
      $records += [pscustomobject]@{
        path = $line
        status = [string]$sig.Status
        statusMessage = [string]$sig.StatusMessage
        subject = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Subject } else { '' }
      }
    }
    ConvertTo-Json -InputObject @($records) -Depth 3 -Compress
  `;
  // PowerShell 7 first, Windows PowerShell second. Both ship
  // Microsoft.PowerShell.Security, but only 5.1 depends on an inherited
  // PSModulePath to autoload it, and a GitHub Actions runner rewrites that
  // variable for 7 - which is how this step failed with "the module could not
  // be loaded" while working on every developer machine. Falling back keeps it
  // working where pwsh is not installed.
  const options = {
    input: [root, ...relativePaths].join('\n'),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  };
  const hostArgs = ['-NoProfile', '-NonInteractive', '-Command', script];
  let stdout;
  let lastError;
  for (const host of ['pwsh', 'powershell.exe']) {
    try {
      stdout = execFileSync(host, hostArgs, options);
      lastError = undefined;
      break;
    } catch (error) {
      // Only a missing host is worth trying the next one for. A PowerShell that
      // ran and failed has a real answer, and retrying would hide it.
      if (error?.code !== 'ENOENT') throw error;
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  const parsed = JSON.parse(stdout.trim() || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.root) {
    console.error('usage: node scripts/verify-windows-signatures.mjs <dir> '
      + '[--allow-unsigned] [--expect-signer <subject>] [--json <file>]');
    return 2;
  }
  if (args.allowUnsigned && args.expectedSigners.length) {
    console.error(
      '--allow-unsigned and --expect-signer are mutually exclusive: naming an '
      + 'expected signer means this is a real release, which cannot be waived.',
    );
    return 2;
  }
  const root = path.resolve(args.root);
  if (!fs.existsSync(root)) {
    console.error(`not found: ${root}`);
    return 2;
  }
  if (process.platform !== 'win32') {
    console.error(
      'Authenticode verification requires Windows. Run this on the windows '
      + 'runner, not the Linux one.',
    );
    return 2;
  }

  const candidates = findCandidates(root);
  const targets = candidates.filter((rel) => targetFor(rel));
  console.log(`scanning ${root}`);
  console.log(`  ${candidates.length} signable files, ${targets.length} policy targets\n`);

  const entries = inspectSignatures(root, targets);
  const report = buildSignatureReport({
    entries,
    allowUnsigned: args.allowUnsigned,
    expectedSigners: args.expectedSigners,
  });

  console.log(formatSignatureReport(report));

  if (args.json) {
    fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    fs.writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\n  report: ${args.json}`);
  }

  console.log(`\n${report.ok ? 'PASS' : 'FAIL'} — signature policy`);
  return report.ok ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 2;
}
