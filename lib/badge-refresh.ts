/**
 * Module-level callback registry for badge counts shown in EmployeeShell.
 *
 * Why not CustomEvent? Server actions running inside React's strict mode
 * + Turbopack Fast Refresh can occasionally drop dispatched events when
 * the listener's useEffect cleanup races with the dispatch. A direct
 * function-call registry sidesteps the event loop entirely: when a
 * supervisor reviews a claim we just call the registered handler.
 *
 * Usage:
 *   - EmployeeShell calls `registerClaimsReviewedHandler(fn)` in a
 *     useEffect; cleanup nulls it out.
 *   - AdminClaimReviewActions calls `notifyClaimsReviewed()` after a
 *     successful approve/reject — the registered handler (if any) runs.
 */

type Handler = () => void

let handler: Handler | null = null

export function registerClaimsReviewedHandler(fn: Handler | null) {
  handler = fn
}

export function notifyClaimsReviewed() {
  handler?.()
}

// Generic "a supervisor just reviewed something — re-sync the nav badge counts
// now" channel. Used by the attendance + leave approval lists which, unlike
// claims, don't navigate away on approve, so the badge would otherwise stay
// stale until the next mount/navigation. The handler just re-pulls
// /api/employee/context (no per-type optimistic decrement).
let refreshHandler: Handler | null = null

export function registerBadgeRefreshHandler(fn: Handler | null) {
  refreshHandler = fn
}

export function notifyBadgeRefresh() {
  refreshHandler?.()
}
