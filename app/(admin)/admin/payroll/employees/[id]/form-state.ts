import type { BaseFormState } from "@/lib/form-state"

/**
 * FormState for the payroll employee-profile save actions.
 *
 * Extends `BaseFormState` with `staleDraftRuns` — the list of DRAFT
 * runs in the org that were marked stale by the save (which the UI
 * shows as a "Re-run payroll" toast link so the admin doesn't have
 * to remember which run needs regenerating).
 *
 * Lives in a form-state.ts file per the "use server" restriction:
 * actions.ts can only export async functions.
 */
export type PayrollProfileFormState = BaseFormState & {
  staleDraftRuns?: Array<{
    id: string
    periodYear: number
    periodMonth: number
  }>
}

export const initialPayrollProfileFormState: PayrollProfileFormState = {
  status: "idle",
  message: "",
}
