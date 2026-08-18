/**
 * Backwards-compatible alias for POST /api/v1/sso-ticket.
 *
 * This route is per-org authenticated (`wp_live_*`), so it does not
 * belong under the `admin/` prefix — that namespace is reserved for
 * master-key provisioning (see `app/api/v1/CLAUDE.md`). The canonical
 * path is `/api/v1/sso-ticket`; this file stays so Altomate Accounting
 * and any partner already pointing at the old URL keeps working.
 *
 * Nothing new should be added here. Deprecate and remove once the
 * known callers have moved over.
 */
export { POST } from "../../sso-ticket/route"
