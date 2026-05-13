import { defineConfig } from "vitest/config"
import path from "node:path"

/**
 * Vitest config — scoped to pure-domain tests only.
 *
 * Why so narrow? `vitest run` will otherwise try to type-check / load
 * every file matching the default `**\/*.test.ts` glob, including
 * server-only modules that pull in Prisma client + Next runtime
 * bindings. We don't want unit tests to need a DB or a Next bundle.
 *
 * Today the only tests live under `modules/*\/domain/__tests__` —
 * exactly the pure helpers (PCB, EPF, OT, allowance caps). Add more
 * include patterns when expanding coverage to other layers.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    include: ["modules/**/domain/__tests__/**/*.test.ts"],
    environment: "node",
    // Pure-function tests should be fast.
    testTimeout: 5000,
  },
})
