/**
 * Form-state types for `/internal/api-scopes` actions.
 *
 * Kept in a separate file (not actions.ts) because `"use server"`
 * files can only export async functions — exporting a `type` or
 * `const` from actions.ts breaks the Next.js build (silent locally,
 * loud in CI). See `app/CLAUDE.md` for the wider rule.
 */

export type InternalUnlockState = {
  status: "idle" | "success" | "error"
  message: string
}

export const initialInternalUnlockState: InternalUnlockState = {
  status: "idle",
  message: "",
}

export type ScopeUpdateState = {
  status: "idle" | "success" | "error"
  message: string
  /// Id of the token that was being edited — useful for showing the
  /// success/error inline on the right row when many tokens render
  /// on the same page.
  tokenId: string | null
}

export const initialScopeUpdateState: ScopeUpdateState = {
  status: "idle",
  message: "",
  tokenId: null,
}
