"use client"

import { useEffect, useMemo, useState } from "react"
import { useActionState } from "react"
import { useRouter } from "next/navigation"
import { Check, Copy, Loader2, RefreshCw, UserPlus } from "lucide-react"

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
import type { AddEmployeeLeaveType } from "@/modules/payroll/application/services/payroll-profile.service"

type PolicyDefaultRow = {
  policyId: string
  leaveTypeId: string
  defaultDays: number
  accrualMethod: "LUMP_SUM" | "PRO_RATED" | null
}

/**
 * Unified "Manage Employee" surface. Wraps the payroll-style employee
 * list (summary row → click → tabbed detail editor) with an inline
 * "Add employee" dialog. The dialog creates a bare member (identity +
 * job title + role + policy); projects, teams, approval-chain and
 * payroll/statutory details are then filled in via the detail
 * editor's tabs.
 */
export type ManageEmployeePendingTransfer = {
  userId: string
  targetOrganizationName: string
  effectiveDate: string
}

export function ManageEmployeeList({
  employees,
  policies,
  leaveTypes,
  policyDefaults,
  canEdit = true,
  pendingTransfers = [],
}: {
  employees: PayrollEmployeeRow[]
  policies: EmployeePolicy[]
  leaveTypes: AddEmployeeLeaveType[]
  policyDefaults: PolicyDefaultRow[]
  /// When false, the directory is rendered as a read-only browse —
  /// Add Employee + Import buttons are hidden, and a banner explains
  /// the restriction.
  canEdit?: boolean
  /// Rows here get a "Transfer pending → target on YYYY-MM-DD" chip
  /// next to their Status badge. Keyed by userId.
  pendingTransfers?: ManageEmployeePendingTransfer[]
}) {
  return (
    <div className="space-y-6">
      {canEdit ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button asChild variant="outline" className="rounded-full">
            <a href="/admin/payroll/employees/export" download>
              Export CSV
            </a>
          </Button>
          <ImportPayrollEmployeesButton
            leaveTypes={leaveTypes}
            policyDefaults={policyDefaults}
          />
          <AddEmployeeDialog
            policies={policies}
            leaveTypes={leaveTypes}
            policyDefaults={policyDefaults}
          />
        </div>
      ) : (
        <div className="rounded-2xl border border-border/60 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          View only — your access doesn&apos;t include the Manage Employee
          module, so adding, importing, or editing employees is disabled.
          Ask the owner if you need to make changes.
        </div>
      )}
      <PayrollEmployeeListTables
        employees={employees}
        pendingTransfers={pendingTransfers}
      />
    </div>
  )
}

function AddEmployeeDialog({
  policies,
  leaveTypes,
  policyDefaults,
}: {
  policies: EmployeePolicy[]
  leaveTypes: AddEmployeeLeaveType[]
  policyDefaults: PolicyDefaultRow[]
}) {
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

  // Default password generation: email + MMDD from DOB.
  const [emailDraft, setEmailDraft] = useState(state.values.email ?? "")
  const [dobDraft, setDobDraft] = useState("")
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  function generatePassword() {
    const email = emailDraft.trim()
    const dob = dobDraft // YYYY-MM-DD
    if (!email || !dob) return
    const [, mm, dd] = dob.split("-")
    setGeneratedPassword(email + mm + dd)
    setCopied(false)
  }

  function copyPassword() {
    if (!generatedPassword) return
    navigator.clipboard.writeText(generatedPassword).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  // Clear generated password if email or DOB changes after generation.
  useEffect(() => {
    setGeneratedPassword(null)
    setCopied(false)
  }, [emailDraft, dobDraft])

  // Leave Method state.
  // ORG_DEFAULT = seed from leave-type defaults (skip policy layer).
  // DEFAULT = seed from policy/type chain.
  // CUSTOM = render one row per active leave type with admin-editable values.
  const [leaveMethod, setLeaveMethod] = useState<"ORG_DEFAULT" | "DEFAULT" | "CUSTOM">("ORG_DEFAULT")

  // Pre-fill inputs in CUSTOM mode with the *resolved* default for
  // the currently-selected policy (policy override → type default).
  // This way the admin only changes what they actually want different.
  const policyDefaultLookup = useMemo(() => {
    const map = new Map<
      string,
      { days: number | null; method: "LUMP_SUM" | "PRO_RATED" | null }
    >()
    for (const d of policyDefaults) {
      map.set(`${d.policyId}:${d.leaveTypeId}`, {
        days: d.defaultDays,
        method: d.accrualMethod,
      })
    }
    return map
  }, [policyDefaults])

  // Empty-state guard: if the org has no leave types, the form can't
  // do anything useful. Show inline error + link to Settings → Leave
  // and disable Submit. Mirrored server-side in
  // `createHierarchyMemberAction`.
  const noLeaveTypes = leaveTypes.length === 0

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
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 sm:max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle>Add employee</DialogTitle>
          <DialogDescription>
            Create the employee with their basic details. You can set
            projects, teams, approval chain, and payroll details from
            their profile tabs afterwards.
          </DialogDescription>
        </DialogHeader>
        {/* Form is a flex column so the body scrolls and the footer
            stays pinned. min-h-0 lets the inner scroll container shrink
            below its content height in the flex layout. */}
        <form
          action={formAction}
          className="mt-4 flex min-h-0 flex-1 flex-col gap-4"
        >
          <div className="flex-1 space-y-4 overflow-y-auto px-1">
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
              value={emailDraft}
              onChange={(e) => setEmailDraft(e.target.value)}
              disabled={pending}
              required
            />
          </Labelled>
          <Labelled label="Phone (optional)">
            <Input
              name="phone"
              type="tel"
              inputMode="tel"
              defaultValue={state.values.phone}
              disabled={pending}
              placeholder="e.g. 0123456789"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Used for forgot-password WhatsApp delivery. Leave blank and
              share the temporary password with them directly.
            </p>
          </Labelled>
          <div className="grid grid-cols-2 gap-3">
            <Labelled label="Date of birth">
              <Input
                name="dob"
                type="date"
                value={dobDraft}
                onChange={(e) => setDobDraft(e.target.value)}
                disabled={pending}
                required
              />
            </Labelled>
            <Labelled label="Join date">
              <Input
                name="joinDate"
                type="date"
                defaultValue={
                  state.values.joinDate ?? new Date().toISOString().slice(0, 10)
                }
                disabled={pending}
              />
            </Labelled>
          </div>
          <Labelled label="Default password">
            <input type="hidden" name="password" value={generatedPassword ?? ""} />
            <div className="space-y-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!emailDraft.trim() || !dobDraft || pending}
                onClick={generatePassword}
                className="w-full gap-2"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Generate default password
              </Button>
              {generatedPassword ? (
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    value={generatedPassword}
                    readOnly
                    className="flex-1 font-mono text-sm"
                  />
                  <button
                    type="button"
                    onClick={copyPassword}
                    className="shrink-0 rounded-lg border border-border/60 p-2 text-muted-foreground hover:text-foreground transition-colors"
                    title="Copy password"
                  >
                    {copied ? (
                      <Check className="h-4 w-4 text-success" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </button>
                </div>
              ) : null}
              <p className="text-[11px] text-muted-foreground">
                Password is email + date of birth (MMDD). Employee should change it after first login.
              </p>
            </div>
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

          {noLeaveTypes ? (
            <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              This organisation has no leave types yet.{" "}
              <a
                href="/admin/leave/settings"
                className="font-semibold underline"
              >
                Set them up in Settings → Leave
              </a>{" "}
              before adding employees.
            </div>
          ) : (
            <>
              <input type="hidden" name="leaveMethod" value={leaveMethod} />
              <Labelled label="Leave method">
                <NativeSelect
                  value={leaveMethod}
                  onChange={(e) =>
                    setLeaveMethod(e.target.value as "ORG_DEFAULT" | "DEFAULT" | "CUSTOM")
                  }
                  disabled={pending}
                >
                  <option value="ORG_DEFAULT">
                    Org default (leave-type defaults)
                  </option>
                  <option value="DEFAULT">Per policy (policy overrides apply)</option>
                  <option value="CUSTOM">Custom (set per leave type)</option>
                </NativeSelect>
              </Labelled>

              {leaveMethod === "CUSTOM" && (
                <CustomLeaveSection
                  leaveTypes={leaveTypes}
                  selectedPolicyId={policyId}
                  policyDefaultLookup={policyDefaultLookup}
                  pending={pending}
                />
              )}
            </>
          )}
          </div>
          <DialogFooter className="shrink-0 border-t border-border/40 pt-4">
            <Button
              type="button"
              variant="outline"
              className="rounded-xl"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="rounded-xl"
              disabled={pending || !policyId || noLeaveTypes}
            >
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

/// Renders the per-leave-type override controls inside the Add
/// Employee dialog's Custom mode. Each row is one paid leave type:
///   - Days input pre-filled with the resolved default for the
///     currently-selected policy (policy override → type default).
///   - Method selector pre-filled the same way.
/// Each row emits hidden inputs `leaveDays.<typeId>` and
/// `leaveMethod.<typeId>` so the server action can read them
/// without knowing the active type list up front.
///
/// Unpaid leave types appear too — admins may want to give a custom
/// unpaid day cap — but always default to 0 days / lump-sum.
function CustomLeaveSection({
  leaveTypes,
  selectedPolicyId,
  policyDefaultLookup,
  pending,
}: {
  leaveTypes: AddEmployeeLeaveType[]
  selectedPolicyId: string
  policyDefaultLookup: Map<
    string,
    { days: number | null; method: "LUMP_SUM" | "PRO_RATED" | null }
  >
  pending: boolean
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-muted/30 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Per leave type
      </p>
      <div className="space-y-2">
        {leaveTypes.map((t) => {
          const policyOverride =
            policyDefaultLookup.get(`${selectedPolicyId}:${t.id}`) ?? null
          const inheritedDays = policyOverride?.days ?? t.defaultDays
          const inheritedMethod = policyOverride?.method ?? t.accrualMethod
          return (
            <PerTypeRow
              key={t.id}
              leaveType={t}
              inheritedDays={inheritedDays}
              inheritedMethod={inheritedMethod}
              pending={pending}
            />
          )
        })}
      </div>
    </div>
  )
}

function PerTypeRow({
  leaveType,
  inheritedDays,
  inheritedMethod,
  pending,
}: {
  leaveType: AddEmployeeLeaveType
  inheritedDays: number
  inheritedMethod: "LUMP_SUM" | "PRO_RATED"
  pending: boolean
}) {
  // Reset back to the inherited values whenever the user changes
  // policy (the parent passes a fresh `inheritedDays` /
  // `inheritedMethod` and we re-key on those). We use uncontrolled
  // inputs with `key={...}` so React resets the value on re-mount.
  const rowKey = `${leaveType.id}:${inheritedDays}:${inheritedMethod}`
  // ANNUAL-only PRO_RATED rule: the method selector is only shown for
  // the Annual Leave row. Other types render an empty cell so the
  // grid stays aligned.
  const isAnnual = leaveType.code.toUpperCase() === "ANNUAL"
  return (
    <div
      key={rowKey}
      className="grid grid-cols-[1fr_5rem_8rem] items-center gap-2 text-sm"
    >
      <div className="truncate">
        <span className="font-mono text-xs font-bold mr-2">{leaveType.code}</span>
        {leaveType.name}
      </div>
      <Input
        type="number"
        step="0.5"
        min="0"
        name={`leaveDays.${leaveType.id}`}
        defaultValue={leaveType.paid ? String(inheritedDays) : "0"}
        disabled={pending || !leaveType.paid}
        className="h-9 text-sm"
        title={`Inherits ${inheritedDays} days from ${
          inheritedDays === leaveType.defaultDays ? "leave type" : "policy"
        }`}
      />
      {isAnnual ? (
        <NativeSelect
          name={`leaveMethod.${leaveType.id}`}
          defaultValue={inheritedMethod}
          disabled={pending || !leaveType.paid}
        >
          <option value="LUMP_SUM">Lump sum</option>
          <option value="PRO_RATED">Pro-rated</option>
        </NativeSelect>
      ) : (
        <span />
      )}
    </div>
  )
}
