/**
 * Backwards-compatible alias for PATCH / DELETE /api/v1/admins/[email].
 *
 * Both methods are per-org authenticated (`wp_live_*`), so they do not
 * belong under the `admin/` prefix — that namespace is reserved for
 * master-key provisioning (see `app/api/v1/CLAUDE.md`).
 *
 * Nothing new should be added here. Deprecate and remove once the
 * known callers have moved over.
 */
export { DELETE, PATCH } from "../../../admins/[email]/route"
