# Stable local macOS signing

Development packages previously used ad-hoc signing. An ad-hoc signature has a
build-specific identity, so macOS Keychain can treat every rebuilt app as a
different caller and repeatedly ask for access.

This project can instead use one self-signed, local code-signing identity. It
does not require Apple Developer Program membership. The certificate and its
private key remain in the current macOS user's login keychain and are not
committed to Git.

## One-time setup

From the repository root:

```sh
npm run macos:signing:setup
npm run macos:signing:check
```

macOS may request the login password once while adding and trusting the local
certificate. This setup approval is separate from API-key access. Afterward,
the app's code identity remains stable across local rebuilds.

The generated identity is named:

```text
Twinscript Local Signing
```

`forge.config.js` selects this identity automatically when it is available.
Fresh machines and CI continue to use ad-hoc signing unless
`MACOS_SIGN_IDENTITY` names another installed identity.

## Repair a credential saved by an older build

Install and open a package built with the stable identity. If Settings reports
that the saved key is locked:

1. Select **Repair secure storage**.
2. Confirm **Repair & Restart** in the native macOS dialog.
3. After the app restarts, enter and validate the OpenAI API key once.

Repair removes only:

- `credentials/openai.enc` beneath this app's Electron `userData` directory;
- the `Twinscript Safe Storage` generic-password entry owned by
  this app in macOS Keychain.

Meeting records, glossaries, preferences, and transcript exports are not
changed. The API key itself is never added to source control or printed by the
setup script.

## Verify a package

```sh
npm run package
codesign -dv --verbose=4 \
  "out/Twinscript-darwin-arm64/Twinscript.app"
```

The output should identify the self-signed local certificate rather than
`Signature=adhoc`.

## Security boundary

This identity is appropriate for this private, single-user validation build.
It does not notarize the app, suppress Gatekeeper warnings on other Macs, or
replace a Developer ID certificate for public distribution.
