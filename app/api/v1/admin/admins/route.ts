/**
 * Backwards-compatible alias for POST /api/v1/admins.
 *
 * Adding an admin is per-org authenticated (`wp_live_*`), so it does not
 * belong under the `admin/` prefix — that namespace is reserved for
 * master-key provisioning (see `app/api/v1/CLAUDE.md`). The canonical
 * path is `/api/v1/admins`, which also serves GET for the list.
 *
 * Note there is deliberately no GET here: the old path never had one,
 * and adding it would re-create the ambiguity this move resolved.
 *
 * Nothing new should be added here. Deprecate and remove once the
 * known callers have moved over.
 */
export { POST } from "../../admins/route"
