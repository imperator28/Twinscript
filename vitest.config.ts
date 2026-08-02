import { defineConfig, configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
    css: true,
    // Vitest owns only the renderer caption UI. Discovery is pinned rather
    // than left to the default glob for two reasons:
    //   1. The caption main-process suites are `node:test` files run by
    //      `npm run test:captions`; the default glob also matched `.cjs` and
    //      reported every one of them as an empty Vitest suite.
    //   2. The remaining `src/` and `electron/` Vitest suites cover upstream
    //      Sokuji providers, TTS, sidecars, stores, and extension-oriented
    //      services that this caption client neither imports nor ships. They
    //      must not gate this product.
    include: [
      'src/captions/**/*.test.{ts,tsx}',
    ],
    exclude: [
      ...configDefaults.exclude,
      // .claude/ holds gitignored worktree checkouts whose stale test copies
      // would otherwise be collected alongside the real suite.
      '**/.claude/**',
      // Legacy Sokuji main-process subsystems reached only from
      // `electron/main.js`, which is not a build entry in vite.config.ts and
      // therefore never ships in dist-electron. Their tests require `fzstd`
      // and `electron-conf`, which this client does not depend on. Quarantined
      // rather than mocked: the modules are dead code here and are slated for
      // removal in a separate change.
      'electron/better-auth-adapter.test.js',
      'electron/sidecar-bundle.test.js',
    ],
  },
})
