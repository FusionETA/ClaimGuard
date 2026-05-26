export type SettingsActionState = {
  status: "idle" | "success" | "error"
  message: string
}

export const initialSettingsActionState: SettingsActionState = {
  status: "idle",
  message: "",
}

/**
 * State for the owner's "invite admin" form. Lives here (not in the
 * "use server" actions file) because a server-action file may only
 * export async functions — exporting this const/type from there throws
 * "A 'use server' file can only export async functions".
 *
 * `confirm` is set when the typed email already belongs to an existing
 * admin: we bounce back asking the owner to confirm linking that person
 * to the current org instead of creating a duplicate.
 */
export type InviteAdminActionState = {
  status: "idle" | "success" | "error" | "confirm"
  message: string
  confirm?: { name: string; email: string }
}

export const initialInviteAdminState: InviteAdminActionState = {
  status: "idle",
  message: "",
}
