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
    //   2. `src/lib/local-inference/` keeps its own suites. That stack is
    //      retained deliberately but nothing in the caption app reaches it, so
    //      its tests must not gate this product.
    //
    // The upstream Sokuji providers, stores, services and the browser extension
    // that this list used to talk around have since been deleted, along with the
    // two quarantined `electron/` suites that required `fzstd` and
    // `electron-conf` - dependencies this client never had.
    include: [
      'src/captions/**/*.test.{ts,tsx}',
      // The capture path is live product code and had no coverage at all, which
      // is how a deleted AudioWorklet reached a meeting. Scoped to modern-audio
      // rather than all of src/lib, because src/lib/local-inference is retained
      // but unreachable and must not gate this product.
      'src/lib/modern-audio/**/*.test.{ts,tsx}',
    ],
    exclude: [
      ...configDefaults.exclude,
      // .claude/ holds gitignored worktree checkouts whose stale test copies
      // would otherwise be collected alongside the real suite.
      '**/.claude/**',
    ],
  },
})
