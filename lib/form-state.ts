/**
 * Common shape for server-action form state. Most actions in this app return
 * either:
 *
 *   - `BaseFormState`                        (no sticky values, no field errors)
 *   - `BaseFormState & { values: V }`        (e.g. login, hierarchy)
 *   - `BaseFormState & { values: V; errors }` (full forms with per-field errors)
 *
 * Use `FormState<V, E>` when starting a new action to avoid spelling these out
 * by hand. Existing form-state types in `app/<route>/form-state.ts` predate
 * this and stay as-is.
 */
export type ActionStatus = "idle" | "success" | "error"

export type BaseFormState = {
  status: ActionStatus
  message: string
}

export type FormState<V = void, E = Record<string, string>> = BaseFormState &
  (V extends void
    ? {}
    : { values: V }) &
  (E extends Record<string, string> ? { errors?: Partial<E> } : {})
