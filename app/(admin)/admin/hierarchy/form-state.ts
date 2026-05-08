import type { EmployeePayoutMethod } from "@/modules/organization/domain/models"

export type HierarchyFormValues = {
  role: "EMPLOYEE" | "SUPERVISOR"
  organizationId: string
  jobTitle: string
  payoutMethod: EmployeePayoutMethod
  xeroConnectionId: string
}

export type AddHierarchyMemberFormValues = HierarchyFormValues & {
  name: string
  email: string
  employeeId: string
  password: string
}

export type HierarchyFormState = {
  status: "idle" | "success" | "error"
  message: string
  values: HierarchyFormValues
}

export function createInitialHierarchyFormState(
  values: Partial<HierarchyFormValues> = {}
): HierarchyFormState {
  return {
    status: "idle",
    message: "",
    values: {
      role: values.role ?? "EMPLOYEE",
      organizationId: values.organizationId ?? "",
      jobTitle: values.jobTitle ?? "",
      payoutMethod: values.payoutMethod ?? "HOURLY",
      xeroConnectionId: values.xeroConnectionId ?? "",
    },
  }
}

export type AddHierarchyMemberFormState = {
  status: "idle" | "success" | "error"
  message: string
  values: AddHierarchyMemberFormValues
}

export function createInitialAddHierarchyMemberFormState(
  values?: Partial<AddHierarchyMemberFormValues>
): AddHierarchyMemberFormState {
  return {
    status: "idle",
    message: "",
    values: {
      name: values?.name ?? "",
      email: values?.email ?? "",
      employeeId: values?.employeeId ?? "",
      password: values?.password ?? "",
      role: values?.role ?? "EMPLOYEE",
      organizationId: values?.organizationId ?? "",
      jobTitle: values?.jobTitle ?? "",
      payoutMethod: values?.payoutMethod ?? "HOURLY",
      xeroConnectionId: values?.xeroConnectionId ?? "",
    },
  }
}
