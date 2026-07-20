/**
 * Client-side recovery from post-deploy version skew.
 *
 * Self-hosted `next start` keeps exactly one `.next` build and overwrites it on
 * every deploy. A tab (or installed PWA) left open across a deploy keeps running
 * the old build's JS: its server-action ids and lazily-loaded chunks no longer
 * exist server-side, so the next interaction throws. `deploymentId` in
 * `next.config.ts` catches most of these and reloads automatically — this is the
 * backstop for what slips past it, mainly chunks already requested by an
 * in-flight navigation.
 *
 * The reload is guarded: a genuine, reproducible bug that happens to look like
 * skew must not put the tab in a refresh loop. We reload at most once per
 * RELOAD_COOLDOWN_MS per tab, tracked in sessionStorage (per-tab, and cleared
 * when the tab closes — sessionStorage is deliberate, not a stand-in for
 * localStorage).
 */

const RELOAD_FLAG = "altomatehr:stale-build-reload-at"
const RELOAD_COOLDOWN_MS = 60_000

/**
 * Error shapes that mean "your JS is older than the server", not "the app is
 * broken". Matched loosely because the wording differs across Next versions and
 * browsers, and minified builds strip some of it.
 */
const SKEW_PATTERNS = [
  /failed to find server action/i,
  /chunkloaderror/i,
  /loading chunk \S+ failed/i,
  /loading css chunk/i,
  /failed to fetch dynamically imported module/i,
  /importing a module script failed/i,
]

export function isStaleBuildError(error: Error & { digest?: string }): boolean {
  const haystack = `${error?.name ?? ""} ${error?.message ?? ""} ${error?.digest ?? ""}`
  return SKEW_PATTERNS.some((pattern) => pattern.test(haystack))
}

/**
 * Reloads once if `error` looks like version skew and this tab hasn't already
 * reloaded recently.
 *
 * Returns true when a reload was triggered, so the caller can render a
 * "updating" state instead of a scary error page for the moment before the
 * navigation happens.
 */
export function recoverFromStaleBuild(
  error: Error & { digest?: string },
): boolean {
  if (typeof window === "undefined") return false
  if (!isStaleBuildError(error)) return false

  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_FLAG) ?? 0)
    if (Number.isFinite(last) && Date.now() - last < RELOAD_COOLDOWN_MS) {
      // Already tried a reload for this tab — the error is not skew after all,
      // so let the normal error UI through rather than looping.
      return false
    }
    window.sessionStorage.setItem(RELOAD_FLAG, String(Date.now()))
  } catch {
    // Private mode / storage disabled: skip recovery rather than risk a loop we
    // have no way to detect.
    return false
  }

  // `reload()` re-requests the document, picking up the current build's HTML
  // and asset URLs.
  window.location.reload()
  return true
}
