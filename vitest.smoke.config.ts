import { defineConfig } from "vitest/config"
import path from "node:path"

/**
 * Smoke-test vitest project — DELIBERATELY separate from `vitest.config.ts`.
 *
 * The default config (run by `npm test`) is scoped to pure-domain unit
 * tests so it stays fast and needs no DB or network. This config is the
 * opposite: it drives the LIVE `/api/v1/*` API of a deployed environment
 * over HTTP, using a scoped `wp_live_smoke_*` token.
 *
 *   npm run smoke
 *
 * Required env (set by `.github/workflows/smoke.yml`, or locally in a
 * shell / .env.local that you source yourself):
 *   - SMOKE_BASE_URL   e.g. https://dev-hr.altomate.io
 *   - SMOKE_API_TOKEN  the wp_live_smoke_* token for the "Smoke Test Co" org
 *
 * If those are unset the suites SKIP (see helpers/client.ts) rather than
 * fail, so an accidental `npm run smoke` without credentials is a no-op.
 *
 * No Prisma, no server-only imports — these tests are pure HTTP clients
 * and must never reach into the database directly.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    include: ["tests/smoke/**/*.smoke.test.ts"],
    environment: "node",
    // Network round-trips against a real deploy; allow generous headroom.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Transient 502s during a fresh pm2 restart shouldn't fail the run.
    retry: 2,
    // Hit one environment; keep the API calls serial so the run is easy
    // to read in CI logs and we never race our own fixtures.
    fileParallelism: false,
  },
})
