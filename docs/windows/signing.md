# Windows code signing (W5)

**Status: not configured, and not required for internal distribution.**

Decision (2026-08-02): this client ships to a known internal audience, so
`.github/workflows/windows-release.yml` runs on `RELEASE_CHANNEL: internal` and
publishes unsigned builds as clearly-labelled **prereleases**. Set that to
`public` before distributing outside the organization; the gate then refuses to
publish anything unsigned.

## Why unsigned is workable internally

| Concern | Reality |
| --- | --- |
| Frame Server loading the media source DLL | **Loads unsigned.** `DllGetClassObject` succeeds in the W4 ETW trace, so signing is not a gate. Signing was explicitly *disproven* as the cause of the blank feed. |
| Squirrel auto-update | Squirrel.Windows does not verify publisher signatures on update. (`electron-updater` does, but this project uses `maker-squirrel`.) |
| Install rights | Squirrel installs per-user into `%LOCALAPPDATA%`; no admin needed. |
| SmartScreen | Warns on browser download via Mark-of-the-Web. Copying from a network share avoids it. Release notes tell users what to expect. |
| Native camera install | Needs elevation for HKLM registration, so UAC shows "Unknown Publisher". Works, but looks alarming. |
| Defender | Slower first scan of a ~134 MB unsigned installer; occasional false positives. |

## Two things that genuinely block unsigned

Check both before rolling out; neither has a workaround from our side.

1. **Smart App Control** (Windows 11) blocks unsigned apps outright, with **no
   override**. It only auto-enables on clean Windows 11 installs.

   ```powershell
   Get-CimInstance -Namespace root/Microsoft/Windows/Defender -ClassName MSFT_MpComputerStatus | Select-Object SmartAppControlState
   ```

   `Off` or `Eval` is fine. `On` means signing is mandatory for that machine.

2. **WDAC / AppLocker.** If IT enforces a code-integrity policy, unsigned code
   will not run regardless of anything in this repository. Ask before rollout.

## If you later need a certificate

Everything below except step 1 is mechanical once a provider is picked. Step 1
is a purchasing and identity decision.

## What is already done

- Signature verification with a tested policy — `npm run verify:signatures`.
  Fails on an empty scan, a missing installer, an unmapped status, tampering, an
  untrusted root, and an unexpected signing certificate.
- A release gate that refuses to publish an unsigned tag with an actionable
  message, while still allowing an explicitly-requested unsigned internal build
  that publishes nothing.
- A tag/version consistency check — `node scripts/verify-tag-version.mjs`.
- A packaged launch/exit smoke test — `npm run smoke:packaged`.

## The ordering constraint that matters

**Sign before packaging, not after.**

`electron-forge make` seals `twinscript.exe`, `vcam-host.exe` and
`twinscript-vcam-source.dll` inside the `.nupkg`, and the `.nupkg` inside
`Setup.exe`. A job that signs only the finished `*Setup*.exe` leaves every one
of those nested binaries unsigned. The inherited `build.yml` SignPath job does
exactly that — its artifact path is `out/make/squirrel.windows/x64/*Setup*.exe`
— so it is not a template to copy.

This is not only cosmetic. `twinscript-vcam-source.dll` is loaded by the Windows
Frame Server, which runs as `NT AUTHORITY\LocalService` outside our process.
Whether that service will load an unsigned in-proc COM server is one of the
open questions in the unresolved W4 investigation
(`docs/windows/evidence/2026-08-02-w4-etw-and-reference-diff/README.md`).
Signing was **disproven** as the cause of the specific blank-feed failure —
`DllGetClassObject` succeeds, so the DLL does load — but a signed DLL is still
the correct end state, and it removes the question permanently.

Use electron-forge's `maker-squirrel` `windowsSign` option, which signs the
packaged binaries and the generated setup, rather than a post-hoc signing step.
The hook point is marked with a comment in `windows-release.yml` between the
native build and `npm run make`.

### Step 1 — choose a provider (blocking, needs a decision)

Since June 2023 every public CA issues code-signing keys only on hardware or via
a cloud signing service; a plain exportable `.pfx` is no longer purchasable.
That makes the practical options:

| Option | Notes |
| --- | --- |
| **Azure Trusted Signing** | Cheapest for an org that already has an Azure tenant. Requires an identity-verified Azure subscription and a `Microsoft.CodeSigning` account. Has a public-facing 3-year org-age requirement for the standard tier. |
| **A cloud HSM / signing service** (DigiCert KeyLocker, SSL.com eSigner, SignPath) | Works from CI without hardware. Cost is per-year plus per-signature or per-seat. |
| **EV certificate on a hardware token** | Best SmartScreen reputation from day one, but a physical token does not work on a hosted GitHub runner without a self-hosted signing box. |

An OV (non-EV) certificate does **not** start with SmartScreen reputation:
early downloads will still show a warning until reputation accrues. Decide
whether that is acceptable for the first release, and record the answer in the
W5 SmartScreen row of the validation matrix either way.

Note the publisher identity should be established under the current app name —
see `docs/windows/rename-2026-08-02.md`.

### Step 2 — configure the repository

Repository **variables** (not secrets — these are not sensitive and the workflow
reads them to decide whether signing is configured at all):

| Variable | Purpose |
| --- | --- |
| `WINDOWS_SIGNING_PROVIDER` | Any non-empty value turns signing on. Setting it while the hook is not wired makes the build fail at verification, which is the intended fail-closed behaviour. |
| `WINDOWS_SIGNING_SUBJECT` | Expected certificate subject, e.g. `CN=Acme Inc.`. Passed to `--expect-signer` so a release signed by the wrong certificate fails. |

Provider **secrets** go in a protected GitHub **environment** named
`windows-signing`, not in repository secrets, so that signing material is
reachable only from a job that declares that environment. Add required reviewers
to the environment if the release should need an approval.

### Step 3 — wire the hook

1. Add the provider's `windowsSign` configuration to the `maker-squirrel` entry
   in `forge.config.js`, reading credentials from the environment.
2. Add `environment: windows-signing` to the `windows-build` job in
   `windows-release.yml` so the credentials are available during `npm run make`.
3. Set the two repository variables above.

### Step 4 — verify before trusting it

```bash
npm run verify:signatures -- out --expect-signer "CN=Your Publisher"
```

This must report every target signed, including the two native camera binaries
and the app executable — not just the installer. An empty scan or a missing
installer fails rather than passing vacuously.

Then confirm the remaining W5 rows in `docs/windows/validation-matrix.md` that
no automated check can cover: clean install on a fresh profile, upgrade
preserving settings and meeting records, uninstall removing the native camera,
and observed SmartScreen behaviour.
