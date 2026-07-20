/**
 * Stamps a stable build identifier into `.build-id` at the repo root.
 *
 * Runs as `prebuild`, so every `npm run build` refreshes it. `next.config.ts`
 * reads the file back for `deploymentId`.
 *
 * Why a file and not `git rev-parse` inside next.config.ts: the config is
 * evaluated twice — once by `next build` (which bakes the id into the client
 * bundles) and again by `next start` (which serves them). Those two reads MUST
 * agree. Shelling out to git each time silently breaks that the moment HEAD
 * moves between build and restart, which is exactly what happens when someone
 * commits in the dev working tree. A file written once at build time and read
 * verbatim thereafter cannot drift.
 */
import { execSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

function resolveBuildId() {
  try {
    const sha = execSync("git rev-parse --short=12 HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
    if (sha) return sha
  } catch {
    // Not a git checkout, or git is unavailable — fall through.
  }
  // Fallback keeps builds distinguishable even without git metadata.
  return `t${Date.now().toString(36)}`
}

const buildId = resolveBuildId()
writeFileSync(join(process.cwd(), ".build-id"), `${buildId}\n`, "utf8")
console.log(`[build-id] ${buildId}`)
