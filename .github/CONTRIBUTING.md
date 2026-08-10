# Contributing

Twinscript is a private, single-maintainer project. There is no open contribution
process and no external issue queue.

What follows is for anyone with access working on it — including future me.

## Before and after every change

```bash
npm test              # renderer and shared logic (Vitest, .ts/.tsx)
npm run test:captions # main process (node:test, .cjs)
npx tsc --noEmit      # compare the error count to the count before your change
npm run build
```

The two suites deliberately do not overlap on file extension. A file picked up by
both runs under the wrong environment.

`tsc` is not clean on this repository. What matters is that your change does not
add errors, so record the count before you start and compare — a single new error
is easy to lose in a few hundred.

## Conventions

- **English only** in comments, commit messages and docs.
- **Conventional commits** (`feat:`, `fix:`, `docs:`, `chore:`).
- Comments explain **why**, and are worth most where the code looks wrong but
  isn't. A comment restating the line above it is noise.
- Match the surrounding code's naming and idiom rather than importing a new style.

## Things that will bite you

- **`npm run dev` launches Electron itself** through `vite-plugin-electron`.
  Stopping Electron stops the dev server; there is no separate start step.
- **The main-process build entry map in `vite.config.ts` is hand-maintained.**
  A module required from a sibling as `./name` must also be listed there, or it is
  never emitted and the app dies at launch with `Cannot find module './name'`.
  `electron/captions/main-build-entries.test.cjs` guards this — but only for bare
  sibling requires, not for `./captions/name`.
- **`assets/` is not inside the asar.** It ships through `extraResource` and lands
  at `process.resourcesPath/assets`, so no single relative path reaches it both
  packaged and unpackaged. See `electron/captions/app-icon.js`.
- **Never put a secret in a `VITE_` variable.** Anything so prefixed is inlined
  into renderer JavaScript and ships with the app. API keys belong in the OS
  credential store — see [safe API key setup](../docs/security/api-key-setup.md).
- **The virtual camera CLSID must never change.** A new one orphans every
  previously registered camera.

## Provenance

Forked from Sokuji v0.34.5 and licensed under [AGPL-3.0](../LICENSE). See the
[reuse map](../docs/architecture/sokuji-reuse-map.md) for what was kept, adapted,
replaced, or excluded. The Windows virtual camera is an independent DirectShow
implementation: no code from any other virtual camera is in this repository, and
none may be added.
