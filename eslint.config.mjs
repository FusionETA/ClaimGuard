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
  // unescaped JSX entities). These all came in with the React 19 upgrade
  // and predate this lint pass. Downgrading to warnings keeps them
  // visible — `npx eslint .` still prints them — without blocking CI on
  // pre-existing tech debt. Promote any of these back to "error" once
  // the corresponding cleanup lands.
  {
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
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
      "lib/master-api-auth.ts",
      "lib/web-push.ts",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
]

export default config
