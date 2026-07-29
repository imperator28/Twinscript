# API key setup

This project has two credential paths: a local development path for Phase 0/1
and an encrypted in-app path for packaged builds. Neither path puts a live key
in Git.

## Local development

Create this ignored file at the repository root:

```text
/Users/jiyu/Documents/Transcription/.env.local
```

Its contents should be:

```dotenv
OPENAI_API_KEY=your-real-key-here
```

Start from the committed `.env.example`, but never put a real value in that
example file:

```bash
cp .env.example .env.local
```

Before adding files to a commit, confirm Git ignores the secret file:

```bash
git check-ignore -v .env.local
git status --short
```

The application must load `.env.local` at runtime in the **Electron main
process only** during development. The key must never:

- use a `VITE_` prefix;
- be imported by renderer code;
- cross the preload bridge or an IPC response;
- be embedded by Vite or Electron Forge at build time;
- appear in a URL, exception, network log, transcript, metric, screenshot, or
  exported diagnostic bundle.

The Realtime WebSocket and Responses API clients run in Electron main. They
read the key through a small credential-provider interface so development
environment loading and packaged-app storage are interchangeable.

## Packaged macOS and Windows builds

Do not ship `.env.local` inside the application and do not bake a CI secret into
the installer.

The user enters the API key once in the app's Settings window. Electron main
encrypts it with the asynchronous `safeStorage` API and stores only ciphertext
under Electron's `app.getPath("userData")` directory. On macOS, `safeStorage`
uses Keychain; on Windows, it uses DPAPI. The renderer receives only credential
state such as `missing`, `available`, or `invalid`, never the key.

Required implementation behavior:

1. Wait for `app.whenReady()` and verify asynchronous encryption is available.
2. Encrypt with `safeStorage.encryptStringAsync`.
3. Write the ciphertext with user-only file permissions where the platform
   supports them.
4. Decrypt only immediately before creating a provider client.
5. Keep plaintext in memory for the shortest practical time.
6. Support replace, validate, and delete without returning the key to the UI.
7. Redact authorization headers and known secret values from all logs.
8. If secure storage is unavailable, block key persistence and explain the
   recovery step; never fall back to plaintext.

## GitHub Actions

Most CI jobs do not need an OpenAI key. Unit tests, builds, linting, and
packaging must use fakes and recorded fixtures.

For an explicitly approved live evaluation job:

- create an environment-scoped GitHub Actions secret named
  `OPENAI_API_KEY`;
- protect that environment with a manual approval;
- expose the secret only to that one job through its `env`;
- do not run the job for fork pull requests or Dependabot;
- never echo the key or write it into the workspace;
- do not pass it to a packaging step or upload it as an artifact;
- set an OpenAI project spend limit and use a dedicated development/evaluation
  project rather than a production key.

GitHub's log redaction and push protection are useful backstops, not permission
to print or commit a key.

## If a key is exposed

Treat a key as compromised as soon as it enters a commit, PR description,
issue, chat, screenshot, or log:

1. Revoke it in the OpenAI dashboard immediately.
2. Create a replacement key.
3. Check usage and spend for unexpected activity.
4. Remove the secret from Git history if it was committed.
5. Confirm all clones and CI artifacts are clean.

Deleting the file in a later commit does not remove the key from Git history,
so rotation is mandatory.

## References

- [OpenAI production best practices](https://developers.openai.com/api/docs/guides/production-best-practices)
- [OpenAI Realtime WebSocket guide](https://developers.openai.com/api/docs/guides/realtime-websocket)
- [Electron `safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage)
- [GitHub Actions secret types](https://docs.github.com/en/code-security/reference/secret-security/secret-types)
- [GitHub push protection](https://docs.github.com/en/code-security/concepts/secret-security/push-protection)
