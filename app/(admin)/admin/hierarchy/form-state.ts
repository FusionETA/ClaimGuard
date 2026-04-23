export type HierarchyFormValues = {
  role: "EMPLOYEE" | "SUPERVISOR"
  project: string
  jobTitle: string
  supervisorId: string
}

export type HierarchyFormState = {
  status: "idle" | "success" | "error"
  message: string
  values: HierarchyFormValues
}

export function createInitialHierarchyFormState(
  values: HierarchyFormValues
): HierarchyFormState {
  return {
    status: "idle",
    message: "",
    values,
  }
}
