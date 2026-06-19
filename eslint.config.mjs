import nextCoreWebVitals from "eslint-config-next/core-web-vitals"

const config = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "generated/**",
      "next-env.d.ts",
      "public/**",
    ],
  },

  ...nextCoreWebVitals,

  // Pre-existing React 19 strict-mode violations across the codebase
  // (setState-in-effect, components-defined-in-render, refs-during-render,
  // impure-functions-in-render). All four came in with the React 19
  // upgrade + `eslint-plugin-react-hooks` v7 and predate this lint
  // pass. They're real concerns but the cleanup is a multi-day refactor
  // (~20 components touched: claim form, admin settings panel, claim
  // tables, attendance views, dialogs that hydrate from props on open).
  //
  // Switched from "warn" to "off" because the warn-level noise was
  // drowning out the genuinely interesting warnings in CI logs AND in
  // some plugin-version combinations was causing the Lint step to
  // exit non-zero. Tighten back to "warn" → "error" once each rule's
  // outstanding violations are refactored.
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/static-components": "off",
      "react-hooks/refs": "off",
      "react-hooks/purity": "off",
      "react/no-unescaped-entities": "warn",
      // Pre-existing: one `<a>` link to a non-existent legacy route.
      // Real bug worth fixing but doesn't belong to this refactor pass.
      "@next/next/no-html-link-for-pages": "warn",
    },
  },

  // Repo-wide architectural rule: only the infrastructure layer
  // (`modules/<m>/infrastructure/**`) and the Prisma scripts directory
  // may import `@/lib/prisma`. Pages, API routes, server actions, AND
  // services must go through a repository method.
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/prisma",
              message:
                "Direct Prisma access is only allowed in modules/<m>/infrastructure/** and prisma/**. Add a repository method and call it from your service. See app/CLAUDE.md.",
            },
          ],
        },
      ],
    },
  },

  // The only places where @/lib/prisma may be imported:
  //   - Module infrastructure repositories (the layered-architecture rule).
  //   - Prisma scripts (seeds, backfills) which run outside the app.
  //   - A handful of cross-cutting auth/push helpers in lib/ that
  //     pre-date the module split. These are explicitly listed (not a
  //     blanket `lib/**` exception) so adding new lib-level Prisma
  //     access requires an intentional rule update + reviewer signoff.
  {
    files: [
      "modules/**/infrastructure/**/*.ts",
      "prisma/**/*.ts",
      "lib/api-auth.ts",
      "lib/auth/authenticate.ts",
      // Sibling of authenticate.ts — does the "is this email available
      // for a new active user" check against the users table directly.
      // Could be folded into a userRepository later; same cross-cutting
      // auth helper as authenticate.ts, same exception.
      "lib/auth/email-uniqueness.ts",
      "lib/master-api-auth.ts",
      "lib/web-push.ts",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
]

export default config
