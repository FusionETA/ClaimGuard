"use client"

import { useEffect, useMemo, useState } from "react"
import { useActionState } from "react"
import { useRouter } from "next/navigation"
import { Loader2, UserPlus } from "lucide-react"

import { createHierarchyMemberAction } from "@/app/(admin)/admin/hierarchy/actions"
import { createInitialAddHierarchyMemberFormState } from "@/app/(admin)/admin/hierarchy/form-state"
import { ImportPayrollEmployeesButton } from "@/components/admin/import-payroll-employees-button"
import { PayrollEmployeeListTables } from "@/components/admin/payroll-employee-list-tables"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { NativeSelect } from "@/components/admin/payroll-form-controls"
import { useToast } from "@/components/ui/toaster"
import type { PayrollEmployeeRow } from "@/modules/payroll/domain/models"
import type { EmployeePolicy } from "@/modules/policy/domain/models"

/**
 * Unified "Manage Employee" surface. Wraps the payroll-style employee
 * list (summary row → click → tabbed detail editor) with an inline
 * "Add employee" dialog. The dialog creates a bare member (identity +
 * job title + role + policy); projects, teams, approval-chain and
 * payroll/statutory details are then filled in via the detail
 * editor's tabs.
 */
export function ManageEmployeeList({
  employees,
  policies,
}: {
  employees: PayrollEmployeeRow[]
  policies: EmployeePolicy[]
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <ImportPayrollEmployeesButton />
        <AddEmployeeDialog policies={policies} />
      </div>
      <PayrollEmployeeListTables employees={employees} />
    </div>
  )
}

function AddEmployeeDialog({ policies }: { policies: EmployeePolicy[] }) {
  const { toast } = useToast()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [state, formAction, pending] = useActionState(
    createHierarchyMemberAction,
    createInitialAddHierarchyMemberFormState(),
  )

  const activePolicies = useMemo(
    () => policies.filter((p) => !p.archived),
    [policies],
  )
  const defaultPolicyId = useMemo(
    () => activePolicies.find((p) => p.isDefault)?.id ?? activePolicies[0]?.id ?? "",
    [activePolicies],
  )
  const [policyId, setPolicyId] = useState(defaultPolicyId)
  useEffect(() => {
    if (!policyId && defaultPolicyId) setPolicyId(defaultPolicyId)
  }, [defaultPolicyId, policyId])

  useEffect(() => {
    if (state.status === "success") {
      toast({ title: state.message, variant: "success" })
      setOpen(false)
      // Server action revalidates, but the client RSC cache still holds
      // the old list — refresh so the new employee row appears now.
      router.refresh()
    }
    if (state.status === "error" && state.message) {
      toast({ title: state.message, variant: "error" })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" className="rounded-full">
          <UserPlus className="mr-2 h-4 w-4" />
          Add employee
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add employee</DialogTitle>
          <DialogDescription>
            Create the employee with their basic details. You can set
            projects, teams, approval chain, and payroll details from
            their profile tabs afterwards.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="policyId" value={policyId} />
          <input type="hidden" name="role" value="EMPLOYEE" />
          <Labelled label="Full name">
            <Input name="name" defaultValue={state.values.name} disabled={pending} required />
          </Labelled>
          <div className="grid grid-cols-2 gap-3">
            <Labelled label="Employee ID">
              <Input
                name="employeeId"
                defaultValue={state.values.employeeId}
                disabled={pending}
                required
              />
            </Labelled>
            <Labelled label="Job title">
              <Input
                name="jobTitle"
                defaultValue={state.values.jobTitle}
                disabled={pending}
                required
              />
            </Labelled>
          </div>
          <Labelled label="Email">
            <Input
              name="email"
              type="email"
              defaultValue={state.values.email}
              disabled={pending}
              required
            />
          </Labelled>
          <Labelled label="Phone (for password reset)">
            <Input
              name="phone"
              type="tel"
              inputMode="tel"
              defaultValue={state.values.phone}
              disabled={pending}
              placeholder="e.g. 0123456789"
              required
            />
          </Labelled>
          <Labelled label="Temporary password">
            <Input
              name="password"
              type="text"
              defaultValue={state.values.password}
              disabled={pending}
              placeholder="At least 8 characters"
              required
            />
          </Labelled>
          <Labelled label="Employee policy">
            <NativeSelect
              value={policyId}
              onChange={(e) => setPolicyId(e.target.value)}
              disabled={pending || activePolicies.length === 0}
            >
              {activePolicies.length === 0 ? (
                <option value="">No policies available</option>
              ) : (
                activePolicies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.isDefault ? " (default)" : ""}
                  </option>
                ))
              )}
            </NativeSelect>
          </Labelled>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="rounded-xl"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" className="rounded-xl" disabled={pending || !policyId}>
              {pending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Adding…
                </>
              ) : (
                "Add employee"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Labelled({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="block space-y-1.5 text-sm font-semibold text-muted-foreground">
      <span>{label}</span>
      {children}
    </label>
  )
}
