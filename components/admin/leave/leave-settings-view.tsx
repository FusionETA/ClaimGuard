"use client"

import { useMemo, useRef, useState, useTransition } from "react"
import { ChevronDown, Pencil } from "lucide-react"

import {
  archiveLeaveTypeAction,
  clearPolicyDefaultAction,
  createLeaveTypeAction,
  resetEmployeeEntitlementAction,
  setEmployeeEntitlementAction,
  setPolicyDefaultAction,
  unarchiveLeaveTypeAction,
  updateLeaveTypeAction,
} from "@/app/(admin)/admin/leave/settings/actions"
import { toggleOrgForecastedLeaveApplyAction } from "@/app/(admin)/admin/settings/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type LeaveTypeRow = {
  id: string
  code: string
  name: string
  paid: boolean
  accrualMethod: "LUMP_SUM" | "PRO_RATED"
  /// Only meaningful for Annual + LUMP_SUM. The LeaveTypeDialog
  /// surfaces the checkbox; the seeder reads it when creating
  /// LeaveEntitlement rows for a year-of-hire employee.
  prorateFirstYear: boolean
  defaultDays: number
  carryForward: boolean
  carryExpiryMonth: number | null
  maxCarryForwardDays: number | null
  archivedAt: string | null
}

type PolicyRow = { id: string; name: string; isDefault: boolean }

type PolicyDefault = {
  policyId: string
  leaveTypeId: string
  defaultDays: number
  /// Per-policy override of `LeaveType.accrualMethod`. Null = inherit.
  accrualMethod: "LUMP_SUM" | "PRO_RATED" | null
}

type EmployeeRow = {
  id: string
  policyId: string | null
  name: string
  email: string
}

type EmployeeEntitlement = {
  employeeId: string
  leaveTypeId: string
  entitledDays: number
  /// Per-employee override of accrualMethod. Null = inherit.
  accrualMethod: "LUMP_SUM" | "PRO_RATED" | null
}

type Tab = "types" | "policies" | "employees"

const PAGE_SIZE = 10

/// Shared Previous/Next pager for the settings tabs. Renders nothing when
/// there's only one page.
function Pager({
  page,
  totalPages,
  total,
  onPrev,
  onNext,
}: {
  page: number
  totalPages: number
  total: number
  onPrev: () => void
  onNext: () => void
}) {
  if (totalPages <= 1) return null
  return (
    <div className="flex items-center justify-between gap-3 px-6 py-3">
      <p className="text-xs text-muted-foreground tabular-nums">
        Showing {(page - 1) * PAGE_SIZE + 1}–
        {Math.min(page * PAGE_SIZE, total)} of {total}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={onPrev}>
          Previous
        </Button>
        <span className="text-xs font-semibold text-muted-foreground tabular-nums">
          Page {page} of {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={onNext}
        >
          Next
        </Button>
      </div>
    </div>
  )
}

export function LeaveSettingsView(props: {
  orgId: string
  year: number
  leaveTypes: LeaveTypeRow[]
  policies: PolicyRow[]
  policyDefaults: PolicyDefault[]
  employees: EmployeeRow[]
  employeeEntitlements: EmployeeEntitlement[]
  /// Org-level toggle: when true, employees can apply for PRO_RATED
  /// leave that hasn't accrued yet but WILL by the leave start date.
  allowForecastedLeaveApply: boolean
}) {
  const [tab, setTab] = useState<Tab>("employees")
  const [editingType, setEditingType] = useState<LeaveTypeRow | "new" | null>(null)

  const activeTypes = props.leaveTypes.filter((t) => !t.archivedAt)
  const annualType = props.leaveTypes.find((t) => t.code.toUpperCase() === "ANNUAL")

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Leave Settings</h1>
          <p className="text-sm text-muted-foreground">
            {tabBlurb(tab, props.year)}
          </p>
        </div>
        {tab === "types" && (
          <Button onClick={() => setEditingType("new")}>New leave type</Button>
        )}
      </div>

      <nav className="-mx-6 overflow-x-auto px-6 nice-scrollbar">
        <div className="flex gap-2 pb-0.5">
          <PillTab active={tab === "employees"} onClick={() => setTab("employees")}>
            Employees
          </PillTab>
          <PillTab active={tab === "policies"} onClick={() => setTab("policies")}>
            Policies
          </PillTab>
          <PillTab active={tab === "types"} onClick={() => setTab("types")}>
            Leave types
          </PillTab>
        </div>
      </nav>

      {tab === "types" && (
        <>
          <LeaveTypesCard
            leaveTypes={props.leaveTypes}
            policyDefaults={props.policyDefaults}
            onEdit={(t) => setEditingType(t)}
          />
          {annualType && (
            <AnnualProrateFirstYearCard annualType={annualType} />
          )}
          {annualType && <AnnualLeaveCard annualType={annualType} />}
          <ForecastedLeaveApplyCard
            initialEnabled={props.allowForecastedLeaveApply}
          />
        </>
      )}

      {tab === "policies" && (
        <PerPolicyOverridesTab
          leaveTypes={activeTypes}
          policies={props.policies}
          defaults={props.policyDefaults}
        />
      )}

      {tab === "employees" && (
        <EmployeeEntitlementsTab
          year={props.year}
          leaveTypes={activeTypes}
          employees={props.employees}
          entitlements={props.employeeEntitlements}
          policyDefaults={props.policyDefaults}
          policies={props.policies}
        />
      )}

      <LeaveTypeDialog
        open={editingType !== null}
        editing={editingType}
        onClose={() => setEditingType(null)}
      />
    </div>
  )
}

function tabBlurb(tab: Tab, year: number): string {
  switch (tab) {
    case "employees":
      return `Review and adjust every employee's leave entitlements for ${year}. Click the edit button on any row to override values; reset to inherit from their policy.`
    case "policies":
      return "Override the leave-type defaults per employee policy. The org default column shows what each policy inherits if left blank."
    case "types":
      return "Define the leave types available in this organisation — what they're called, whether they're paid, the default day count, and how they accrue."
  }
}

function PillTab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "shrink-0 rounded-full border px-4 py-1.5 text-xs font-semibold transition-colors " +
        (active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border/60 bg-card text-muted-foreground hover:text-foreground")
      }
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Leave Types table
// ---------------------------------------------------------------------------

function LeaveTypesCard(props: {
  leaveTypes: LeaveTypeRow[]
  policyDefaults: PolicyDefault[]
  onEdit: (t: LeaveTypeRow) => void
}) {
  const [pending, startTransition] = useTransition()
  const [page, setPage] = useState(1)

  const policyCountByType = useMemo(() => {
    const counts = new Map<string, Set<string>>()
    for (const d of props.policyDefaults) {
      const s = counts.get(d.leaveTypeId) ?? new Set<string>()
      s.add(d.policyId)
      counts.set(d.leaveTypeId, s)
    }
    return counts
  }, [props.policyDefaults])

  const totalPages = Math.max(1, Math.ceil(props.leaveTypes.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageTypes = props.leaveTypes.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE,
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Leave types</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {props.leaveTypes.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-muted-foreground">
            No leave types yet. Create one to get started.
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Paid</TableHead>
                  <TableHead>Accrual</TableHead>
                  <TableHead>Default</TableHead>
                  <TableHead>Carry FWD</TableHead>
                  <TableHead>Policy overrides</TableHead>
                  <TableHead className="text-right"> </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageTypes.map((t) => {
                  const isProtected = t.code.toUpperCase() === "UNPAID"
                  const policyCount = policyCountByType.get(t.id)?.size ?? 0
                  return (
                    <TableRow key={t.id} className={t.archivedAt ? "opacity-60" : ""}>
                      <TableCell className="font-mono text-xs font-bold">{t.code}</TableCell>
                      <TableCell>{t.name}</TableCell>
                      <TableCell>
                        <Badge variant={t.paid ? "paid" : "outline"}>
                          {t.paid ? "Paid" : "Unpaid"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {t.accrualMethod === "PRO_RATED" ? "Pro-rated" : "Lump sum"}
                      </TableCell>
                      <TableCell>{t.paid ? t.defaultDays : "—"}</TableCell>
                      <TableCell>{t.carryForward ? "Yes" : "No"}</TableCell>
                      <TableCell>
                        {policyCount > 0 ? (
                          <span className="inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium border-sky-300 bg-sky-50 text-sky-700">
                            {policyCount} {policyCount === 1 ? "policy" : "policies"}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {isProtected ? (
                          <span className="text-xs text-muted-foreground">System default</span>
                        ) : (
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={() => props.onEdit(t)}>
                              Edit
                            </Button>
                            {t.archivedAt ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={pending}
                                onClick={() => startTransition(() => unarchiveLeaveTypeAction(t.id))}
                              >
                                Restore
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={pending}
                                onClick={() => startTransition(() => archiveLeaveTypeAction(t.id))}
                              >
                                Archive
                              </Button>
                            )}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            <div className="border-t">
              <Pager
                page={safePage}
                totalPages={totalPages}
                total={props.leaveTypes.length}
                onPrev={() => setPage((p) => Math.max(1, p - 1))}
                onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
              />
            </div>
            <p className="px-6 py-3 text-xs text-muted-foreground border-t">
              Changing a default here doesn&apos;t retroactively update employees who already have
              entitlement rows — only new employees created after the change are affected.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Annual-leave carry-forward + expiry card
// ---------------------------------------------------------------------------

/// Annual-leave-only setting: when LUMP_SUM, should mid-year hires
/// get a prorated quota in their year of hire (year 2+ resets to
/// full)? Shown as a toggle in its own card on the Leave Types tab
/// so admins don't have to dive into the edit dialog to find it.
///
/// Hidden entirely (returns null) when Annual Leave's accrualMethod
/// is PRO_RATED — proration is already part of that model and the
/// flag has no effect, so showing it would be misleading.
function AnnualProrateFirstYearCard({
  annualType,
}: {
  annualType: LeaveTypeRow
}) {
  const [enabled, setEnabled] = useState(annualType.prorateFirstYear)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  if (annualType.accrualMethod !== "LUMP_SUM") return null

  function flip(next: boolean) {
    setEnabled(next)
    setError(null)
    // Build the full type patch — `updateLeaveTypeAction` expects
    // every field, then preserves the others as-is.
    const fd = new FormData()
    fd.set("code", annualType.code)
    fd.set("name", annualType.name)
    if (annualType.paid) fd.set("paid", "on")
    fd.set("accrualMethod", annualType.accrualMethod)
    fd.set("defaultDays", String(annualType.defaultDays))
    if (annualType.carryForward) fd.set("carryForward", "on")
    if (annualType.carryForward && annualType.carryExpiryMonth != null) {
      fd.set("carryExpiryMonth", String(annualType.carryExpiryMonth))
    }
    if (annualType.maxCarryForwardDays != null) {
      fd.set("maxCarryForwardDays", String(annualType.maxCarryForwardDays))
    }
    if (next) fd.set("prorateFirstYear", "on")
    startTransition(async () => {
      const res = await updateLeaveTypeAction(annualType.id, fd)
      if (!res.ok) {
        setError(res.error)
        setEnabled(!next) // revert the optimistic flip
      }
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Annual leave — first-year proration</CardTitle>
        <p className="text-sm text-muted-foreground">
          When ON, mid-year hires get a prorated annual quota in their
          year of hire (e.g. <span className="font-mono">14 × months-remaining / 12</span>).
          From year 2 onwards everyone gets the full quota on Jan 1.
        </p>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-foreground">
              Prorate first year for new hires
            </p>
            <p className="text-xs text-muted-foreground">
              Applies to every employee whose joinDate falls in this
              calendar year. Existing rows aren't recomputed
              retroactively — only newly-seeded entitlements and rows
              touched by a joinDate save will pick up the new setting.
            </p>
          </div>
          <Switch enabled={enabled} pending={pending} onChange={flip} />
        </div>
        {error && (
          <p className="mt-2 text-sm text-destructive">{error}</p>
        )}
      </CardContent>
    </Card>
  )
}

/// Org-wide switch that lets employees apply for PRO_RATED leave
/// that hasn't accrued yet but WILL by the leave's start date. When
/// OFF (default), the strict balance rule applies.
function ForecastedLeaveApplyCard({
  initialEnabled,
}: {
  initialEnabled: boolean
}) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function flip(next: boolean) {
    setEnabled(next)
    setError(null)
    startTransition(async () => {
      const res = await toggleOrgForecastedLeaveApplyAction(next)
      if (!res.ok) {
        setError(res.message)
        setEnabled(!next)
      }
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Forecasted leave applications</CardTitle>
        <p className="text-sm text-muted-foreground">
          Let employees apply for pro-rated leave that will accrue by
          the leave&apos;s start date — instead of strictly checking
          against today&apos;s balance. Only affects PRO_RATED leave
          types; LUMP_SUM is unaffected.
        </p>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-foreground">
              Allow forecasted apply
            </p>
            <p className="text-xs text-muted-foreground">
              Example: in January an employee with 1 day accrued can book
              6 days for June, because the monthly accrual will have
              credited them by then.
            </p>
          </div>
          <Switch enabled={enabled} pending={pending} onChange={flip} />
        </div>
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  )
}

/// Tailwind-only toggle. Same a11y semantics as a checkbox (button
/// with role="switch" + aria-checked). Avoids adding a Radix Switch
/// dep just for this one control.
function Switch({
  enabled,
  pending,
  onChange,
}: {
  enabled: boolean
  pending: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={pending}
      onClick={() => onChange(!enabled)}
      className={
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed " +
        (enabled
          ? "bg-primary border-primary"
          : "bg-muted border-border/60")
      }
    >
      <span
        className={
          "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform " +
          (enabled ? "translate-x-5" : "translate-x-0.5")
        }
      />
    </button>
  )
}

function AnnualLeaveCard({ annualType }: { annualType: LeaveTypeRow }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [carryForward, setCarryForward] = useState(annualType.carryForward)
  const [expiryMonth, setExpiryMonth] = useState(
    annualType.carryExpiryMonth != null ? String(annualType.carryExpiryMonth) : "",
  )
  const [maxCarry, setMaxCarry] = useState(
    annualType.maxCarryForwardDays != null ? String(annualType.maxCarryForwardDays) : "",
  )

  function submit() {
    setError(null)
    const fd = new FormData()
    fd.set("code", annualType.code)
    fd.set("name", annualType.name)
    if (annualType.paid) fd.set("paid", "on")
    fd.set("accrualMethod", annualType.accrualMethod)
    fd.set("defaultDays", String(annualType.defaultDays))
    if (carryForward) fd.set("carryForward", "on")
    if (carryForward && expiryMonth) fd.set("carryExpiryMonth", expiryMonth)
    if (maxCarry !== "") fd.set("maxCarryForwardDays", maxCarry)
    startTransition(async () => {
      const res = await updateLeaveTypeAction(annualType.id, fd)
      if (!res.ok) setError(res.error)
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Annual leave carry-forward</CardTitle>
        <p className="text-sm text-muted-foreground">
          Carry-forward and expiry rules only apply to annual leave.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label>Carry forward</Label>
            <Select value={carryForward ? "yes" : "no"} onValueChange={(v) => setCarryForward(v === "yes")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="no">No</SelectItem>
                <SelectItem value="yes">Yes</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="annualExpiryMonth">Expiry month (1-12)</Label>
            <Input
              id="annualExpiryMonth"
              type="number"
              min="1"
              max="12"
              value={expiryMonth}
              onChange={(e) => setExpiryMonth(e.target.value)}
              disabled={!carryForward}
              placeholder="e.g. 3"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Carried days expire at the start of this month next year.
            </p>
          </div>
          <div>
            <Label htmlFor="annualMaxCarry">Max carry-forward days</Label>
            <Input
              id="annualMaxCarry"
              type="number"
              step="0.5"
              min="0"
              value={maxCarry}
              onChange={(e) => setMaxCarry(e.target.value)}
              disabled={!carryForward}
              placeholder="Uncapped"
            />
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end">
          <Button onClick={submit} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// New / Edit dialog (without carry/expiry — those live on the annual card)
// ---------------------------------------------------------------------------

function LeaveTypeDialog(props: {
  open: boolean
  editing: LeaveTypeRow | "new" | null
  onClose: () => void
}) {
  const isNew = props.editing === "new"
  const t: LeaveTypeRow | null =
    props.editing === null || props.editing === "new" ? null : props.editing
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [code, setCode] = useState("")
  const [name, setName] = useState("")
  const [paid, setPaid] = useState(true)
  const [accrualMethod, setAccrualMethod] = useState<"LUMP_SUM" | "PRO_RATED">("LUMP_SUM")
  const [defaultDays, setDefaultDays] = useState("0")

  const lastEditingId = useRef<string | "new" | null>(null)
  if (props.open && lastEditingId.current !== (t?.id ?? (isNew ? "new" : null))) {
    lastEditingId.current = t?.id ?? (isNew ? "new" : null)
    setCode(t?.code ?? "")
    setName(t?.name ?? "")
    setPaid(t?.paid ?? true)
    setAccrualMethod(t?.accrualMethod ?? "LUMP_SUM")
    setDefaultDays(String(t?.defaultDays ?? 0))
    setError(null)
  }

  const isAnnual = code.trim().toUpperCase() === "ANNUAL"
  const effectiveAccrual = isAnnual ? accrualMethod : "LUMP_SUM"

  async function submit() {
    setError(null)
    const fd = new FormData()
    fd.set("code", code)
    fd.set("name", name)
    if (paid) fd.set("paid", "on")
    fd.set("accrualMethod", effectiveAccrual)
    // Preserve the type's existing prorate-first-year value (it's
    // edited on the dedicated AnnualProrateFirstYearCard below the
    // Leave Types table, not in this dialog). Default false for new
    // types — the toggle defaults off and is only meaningful for
    // Annual + LUMP_SUM anyway.
    if (t?.prorateFirstYear) fd.set("prorateFirstYear", "on")
    fd.set("defaultDays", paid ? defaultDays : "0")
    // Carry-forward fields are managed on the AnnualLeaveCard — preserve
    // the existing values when editing an existing row.
    if (t?.carryForward) fd.set("carryForward", "on")
    if (t?.carryForward && t.carryExpiryMonth != null) {
      fd.set("carryExpiryMonth", String(t.carryExpiryMonth))
    }
    if (t?.maxCarryForwardDays != null) {
      fd.set("maxCarryForwardDays", String(t.maxCarryForwardDays))
    }

    startTransition(async () => {
      const res = isNew
        ? await createLeaveTypeAction(fd)
        : await updateLeaveTypeAction(t!.id, fd)
      if (!res.ok) {
        setError(res.error)
        return
      }
      props.onClose()
    })
  }

  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isNew ? "New leave type" : `Edit ${t?.code}`}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="code">Code</Label>
              <Input
                id="code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={!isNew}
                placeholder="ANNUAL"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Use ANNUAL for the annual-leave type (enables pro-rated + carry-forward).
              </p>
            </div>
            <div>
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Paid?</Label>
              <Select value={paid ? "paid" : "unpaid"} onValueChange={(v) => setPaid(v === "paid")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="paid">Paid</SelectItem>
                  <SelectItem value="unpaid">Unpaid</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="defaultDays">Default days</Label>
              <Input
                id="defaultDays"
                type="number"
                step="0.5"
                min="0"
                value={paid ? defaultDays : "0"}
                onChange={(e) => setDefaultDays(e.target.value)}
                disabled={!paid}
              />
              {!paid && (
                <p className="text-xs text-muted-foreground mt-1">
                  Unpaid leave has no entitlement.
                </p>
              )}
            </div>
          </div>

          <div>
            <Label>Accrual method</Label>
            <Select
              value={effectiveAccrual}
              onValueChange={(v) => setAccrualMethod(v as "LUMP_SUM" | "PRO_RATED")}
              disabled={!isAnnual}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="LUMP_SUM">Lump sum (all available at year start)</SelectItem>
                <SelectItem value="PRO_RATED">Pro-rated (entitledDays / 12 each month)</SelectItem>
              </SelectContent>
            </Select>
            {!isAnnual && (
              <p className="text-xs text-muted-foreground mt-1">
                Pro-rated is only available for ANNUAL leave.
              </p>
            )}
          </div>

          {isAnnual && (
            <p className="text-xs text-muted-foreground">
              Configure carry-forward + expiry on the "Annual leave carry-forward" card.
            </p>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>Cancel</Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Per-policy overrides (tab)
//
// Replaces the old wide "policy × leave-type" matrix with one Card per
// policy. Each Card contains a Table with one row per leave type, so
// admins read top-to-bottom (which leave type is overridden for THIS
// policy) instead of having to scan a sprawling 2D grid.
// ---------------------------------------------------------------------------

function PerPolicyOverridesTab(props: {
  leaveTypes: LeaveTypeRow[]
  policies: PolicyRow[]
  defaults: PolicyDefault[]
}) {
  const lookup = useMemo(() => {
    const map = new Map<
      string,
      { days: number; method: "LUMP_SUM" | "PRO_RATED" | null }
    >()
    for (const d of props.defaults) {
      map.set(`${d.policyId}:${d.leaveTypeId}`, {
        days: d.defaultDays,
        method: d.accrualMethod,
      })
    }
    return map
  }, [props.defaults])

  const [page, setPage] = useState(1)

  // Only paid leave types can carry custom day counts (unpaid leave
  // always resolves to 0); filtering here matches the matrix's old
  // behaviour and keeps each policy card focused.
  const paidTypes = props.leaveTypes.filter((t) => t.paid)

  const totalPages = Math.max(1, Math.ceil(props.policies.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pagePolicies = props.policies.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE,
  )

  if (props.policies.length === 0 || paidTypes.length === 0) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          {props.policies.length === 0
            ? "Add at least one employee policy in Settings → Employees to configure per-policy overrides."
            : "Add at least one paid leave type to configure per-policy overrides."}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      {pagePolicies.map((p) => {
        // Quick header summary: how many overrides this policy holds.
        const overrideCount = paidTypes.filter(
          (t) => lookup.get(`${p.id}:${t.id}`) != null,
        ).length
        return (
          <PolicyCollapsibleCard
            key={p.id}
            policy={p}
            paidTypes={paidTypes}
            lookup={lookup}
            overrideCount={overrideCount}
          />
        )
      })}
      <Pager
        page={safePage}
        totalPages={totalPages}
        total={props.policies.length}
        onPrev={() => setPage((p) => Math.max(1, p - 1))}
        onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
      />
    </div>
  )
}

/// Collapsible card for one policy. Header is the click target —
/// shows the policy name, default badge, override count, and a
/// rotating chevron. Body (the leave-type table) only mounts when
/// expanded, so reloading the Per-policy tab on a big org is fast
/// and admins aren't drowned in fields they don't need to see.
///
/// Each card manages its own open/closed state. We accept that
/// reordering or filtering the policy list later would lose the
/// in-flight expansion state — that's a fair trade for not threading
/// state through the parent.
function PolicyCollapsibleCard({
  policy,
  paidTypes,
  lookup,
  overrideCount,
}: {
  policy: PolicyRow
  paidTypes: LeaveTypeRow[]
  lookup: Map<
    string,
    { days: number; method: "LUMP_SUM" | "PRO_RATED" | null }
  >
  overrideCount: number
}) {
  const [open, setOpen] = useState(false)
  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-6 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-[28px]"
        aria-expanded={open}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">{policy.name}</CardTitle>
            {policy.isDefault && (
              <Badge variant="outline" className="text-[10px]">
                Default
              </Badge>
            )}
            {/* Source pill: Default (green) if no per-policy
                overrides, Custom (red) if any leave type is
                overridden. Same colour language as the per-employee
                pill on the picker / balances grid. */}
            <PolicySourceBadge overrideCount={overrideCount} />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {overrideCount === 0
              ? "Inherits every leave type from the type defaults."
              : `${overrideCount} leave type${overrideCount === 1 ? "" : "s"} overridden.`}
          </p>
        </div>
        <ChevronDown
          className={
            "h-5 w-5 shrink-0 text-muted-foreground transition-transform " +
            (open ? "rotate-180" : "")
          }
        />
      </button>
      {open && (
        <CardContent className="p-0 pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Leave type</TableHead>
                <TableHead className="w-28">Org default</TableHead>
                <TableHead className="w-36">This policy</TableHead>
                <TableHead className="w-48">Accrual method</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paidTypes.map((t) => {
                const cell = lookup.get(`${policy.id}:${t.id}`) ?? null
                return (
                  <PolicyOverrideRow
                    key={t.id}
                    policyId={policy.id}
                    leaveType={t}
                    daysValue={cell?.days ?? null}
                    methodValue={cell?.method ?? null}
                  />
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      )}
    </Card>
  )
}

function PolicyOverrideRow(props: {
  policyId: string
  leaveType: LeaveTypeRow
  daysValue: number | null
  methodValue: "LUMP_SUM" | "PRO_RATED" | null
}) {
  const [val, setVal] = useState(
    props.daysValue !== null ? String(props.daysValue) : "",
  )
  const [pending, startTransition] = useTransition()
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const methodSelectValue: "LUMP_SUM" | "PRO_RATED" | "__DEFAULT__" =
    props.methodValue ?? "__DEFAULT__"
  const isOverriddenDays = props.daysValue !== null
  const isOverriddenMethod = props.methodValue !== null

  function flashSaved() {
    if (savedTimer.current) clearTimeout(savedTimer.current)
    setSaved(true)
    savedTimer.current = setTimeout(() => setSaved(false), 2000)
  }

  return (
    <TableRow>
      <TableCell>
        <span className="font-mono text-xs font-bold mr-2">{props.leaveType.code}</span>
        {props.leaveType.name}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {props.leaveType.defaultDays} days
      </TableCell>
      <TableCell>
        <Input
          type="number"
          step="0.5"
          min="0"
          className={
            "h-9 w-28 " +
            (isOverriddenDays ? "" : "text-muted-foreground")
          }
          placeholder={`${props.leaveType.defaultDays} (type)`}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={() => {
            const numeric = val.trim() === "" ? null : Number(val)
            if (numeric === null) {
              if (props.methodValue !== null) {
                startTransition(async () => {
                  await setPolicyDefaultAction({
                    policyId: props.policyId,
                    leaveTypeId: props.leaveType.id,
                    defaultDays: props.leaveType.defaultDays,
                  })
                  flashSaved()
                })
                return
              }
              if (props.daysValue !== null) {
                startTransition(async () => {
                  await clearPolicyDefaultAction({
                    policyId: props.policyId,
                    leaveTypeId: props.leaveType.id,
                  })
                  flashSaved()
                })
              }
              return
            }
            if (numeric === props.daysValue) return
            startTransition(async () => {
              await setPolicyDefaultAction({
                policyId: props.policyId,
                leaveTypeId: props.leaveType.id,
                defaultDays: numeric,
              })
              flashSaved()
            })
          }}
          disabled={pending}
        />
      </TableCell>
      {/* ANNUAL-only PRO_RATED rule: method dropdown is only available
          for Annual Leave. For every other type the cell is empty
          (the constraint matches the LeaveTypeDialog gate). */}
      <TableCell>
        <div className="flex items-center gap-2">
          {props.leaveType.code.toUpperCase() === "ANNUAL" ? (
            <Select
              value={methodSelectValue}
              onValueChange={(v) => {
                const next: "LUMP_SUM" | "PRO_RATED" | null =
                  v === "__DEFAULT__" ? null : (v as "LUMP_SUM" | "PRO_RATED")
                startTransition(async () => {
                  await setPolicyDefaultAction({
                    policyId: props.policyId,
                    leaveTypeId: props.leaveType.id,
                    accrualMethod: next,
                  })
                  flashSaved()
                })
              }}
              disabled={pending}
            >
              <SelectTrigger
                className={
                  "h-9 w-44 text-sm " +
                  (isOverriddenMethod ? "" : "text-muted-foreground")
                }
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__DEFAULT__">
                  Inherit from type ({props.leaveType.accrualMethod === "PRO_RATED" ? "pro-rated" : "lump sum"})
                </SelectItem>
                <SelectItem value="LUMP_SUM">Lump sum</SelectItem>
                <SelectItem value="PRO_RATED">Pro-rated</SelectItem>
              </SelectContent>
            </Select>
          ) : null}
          {saved && (
            <span className="text-xs font-medium text-emerald-600 transition-opacity">
              ✓ Saved
            </span>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

// ---------------------------------------------------------------------------
// Per-employee entitlements (tab)
// ---------------------------------------------------------------------------

function EmployeeEntitlementsTab(props: {
  year: number
  leaveTypes: LeaveTypeRow[]
  employees: EmployeeRow[]
  entitlements: EmployeeEntitlement[]
  policyDefaults: PolicyDefault[]
  policies: PolicyRow[]
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
  const [page, setPage] = useState(1)

  const lookup = useMemo(() => {
    const map = new Map<
      string,
      { days: number; method: "LUMP_SUM" | "PRO_RATED" | null }
    >()
    for (const e of props.entitlements) {
      map.set(`${e.employeeId}:${e.leaveTypeId}`, {
        days: e.entitledDays,
        method: e.accrualMethod,
      })
    }
    return map
  }, [props.entitlements])

  const entitlementsByEmployee = useMemo(() => {
    const map = new Map<
      string,
      Array<{ leaveTypeId: string; entitledDays: number; accrualMethod: "LUMP_SUM" | "PRO_RATED" | null }>
    >()
    for (const e of props.entitlements) {
      const list = map.get(e.employeeId) ?? []
      list.push({ leaveTypeId: e.leaveTypeId, entitledDays: e.entitledDays, accrualMethod: e.accrualMethod })
      map.set(e.employeeId, list)
    }
    return map
  }, [props.entitlements])

  const policyOverrideLookup = useMemo(() => {
    const map = new Map<
      string,
      { days: number | null; method: "LUMP_SUM" | "PRO_RATED" | null }
    >()
    for (const d of props.policyDefaults) {
      map.set(`${d.policyId}:${d.leaveTypeId}`, {
        days: d.defaultDays,
        method: d.accrualMethod,
      })
    }
    return map
  }, [props.policyDefaults])

  const policyById = useMemo(
    () => new Map(props.policies.map((p) => [p.id, p])),
    [props.policies],
  )

  const filteredEmployees = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return props.employees
    return props.employees.filter(
      (e) =>
        e.name.toLowerCase().includes(needle) ||
        e.email.toLowerCase().includes(needle),
    )
  }, [props.employees, filter])

  const totalPages = Math.max(1, Math.ceil(filteredEmployees.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageEmployees = filteredEmployees.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE,
  )

  if (props.employees.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          No employees yet — add one from Settings → Employees to set per-employee leave overrides.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      <Input
        placeholder="Search by name or email"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value)
          setPage(1)
        }}
        className="max-w-xs"
      />
      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Employee</TableHead>
              <TableHead>Policy</TableHead>
              <TableHead>Leave source</TableHead>
              <TableHead className="w-10"> </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredEmployees.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center py-6 text-sm text-muted-foreground">
                  No matches.
                </TableCell>
              </TableRow>
            ) : (
              pageEmployees.flatMap((emp) => {
                const isExpanded = expandedId === emp.id
                const source = resolveEmployeeLeaveSource({
                  employeePolicyId: emp.policyId,
                  leaveTypes: props.leaveTypes,
                  policyDefaults: props.policyDefaults,
                  employeeEntitlements: entitlementsByEmployee.get(emp.id) ?? [],
                })
                const rows: React.ReactNode[] = [
                  <TableRow key={emp.id} className={isExpanded ? "bg-muted/30" : ""}>
                    <TableCell>
                      <div className="font-medium text-sm">{emp.name}</div>
                      <div className="text-xs text-muted-foreground">{emp.email}</div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {policyById.get(emp.policyId ?? "")?.name ?? "—"}
                    </TableCell>
                    <TableCell>
                      <LeaveSourceBadge source={source} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setExpandedId(isExpanded ? null : emp.id)}
                        title="Edit leave entitlements"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>,
                ]
                if (isExpanded) {
                  rows.push(
                    <TableRow key={emp.id + "-editor"}>
                      <TableCell colSpan={4} className="bg-muted/20 p-0">
                        <div className="px-4 py-3 border-t">
                          <p className="text-xs font-medium text-muted-foreground mb-2">
                            {emp.name} — overrides for {props.year}
                          </p>
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Leave type</TableHead>
                                <TableHead className="w-32">Days</TableHead>
                                <TableHead className="w-48">Accrual method</TableHead>
                                <TableHead className="w-12 text-right"> </TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {props.leaveTypes.map((t) => {
                                const cell = lookup.get(`${emp.id}:${t.id}`) ?? null
                                const policyOverride = emp.policyId
                                  ? (policyOverrideLookup.get(`${emp.policyId}:${t.id}`) ?? null)
                                  : null
                                const inheritedMethod = policyOverride?.method ?? t.accrualMethod
                                const inheritedFrom: "policy" | "type" =
                                  policyOverride?.method != null ? "policy" : "type"
                                return (
                                  <EmployeeEntitlementRow
                                    key={t.id}
                                    employeeId={emp.id}
                                    leaveType={t}
                                    year={props.year}
                                    currentDays={cell?.days ?? null}
                                    currentMethod={cell?.method ?? null}
                                    inheritedMethod={inheritedMethod}
                                    inheritedFrom={inheritedFrom}
                                  />
                                )
                              })}
                            </TableBody>
                          </Table>
                        </div>
                      </TableCell>
                    </TableRow>,
                  )
                }
                return rows
              })
            )}
          </TableBody>
        </Table>
      </div>
      <Pager
        page={safePage}
        totalPages={totalPages}
        total={filteredEmployees.length}
        onPrev={() => setPage((p) => Math.max(1, p - 1))}
        onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
      />
    </div>
  )
}

/// What source layer is "in effect" for this employee, summarised
/// across every paid leave type in the org.
///
///   - "custom"  → at least one LeaveEntitlement row has a per-
///                 employee override (days differ from the resolved
///                 default, OR accrualMethod is non-null).
///   - "policy"  → no per-employee override anywhere, but the
///                 employee's policy has at least one
///                 PolicyLeaveEntitlement override (days or method).
///   - "default" → both layers are empty; resolves entirely to the
///                 leave type's `defaultDays` / `accrualMethod`.
export type EmployeeLeaveSource = "default" | "policy" | "custom"

/// Compute the overall source for a single employee. Pure function
/// so we can call it from both the Settings → Per-employee picker
/// (with policyDefaults + employeeEntitlements props in scope) and
/// the admin balances grid (server pre-computes it on the
/// EmployeeLeaveBalances payload).
export function resolveEmployeeLeaveSource({
  employeePolicyId,
  leaveTypes,
  policyDefaults,
  employeeEntitlements,
}: {
  employeePolicyId: string | null
  leaveTypes: Array<{ id: string; defaultDays: number; accrualMethod: "LUMP_SUM" | "PRO_RATED"; paid: boolean }>
  /// All policy-default rows for this org (we filter by policy below).
  policyDefaults: Array<{
    policyId: string
    leaveTypeId: string
    defaultDays: number
    accrualMethod: "LUMP_SUM" | "PRO_RATED" | null
  }>
  /// Per-employee LeaveEntitlement rows for *this* employee only.
  employeeEntitlements: Array<{
    leaveTypeId: string
    entitledDays: number
    accrualMethod: "LUMP_SUM" | "PRO_RATED" | null
  }>
}): EmployeeLeaveSource {
  const typesById = new Map(leaveTypes.map((t) => [t.id, t]))
  const policyByLeaveTypeId = new Map(
    policyDefaults
      .filter((d) => d.policyId === employeePolicyId)
      .map((d) => [d.leaveTypeId, d]),
  )

  // Pass 1 — any per-employee override on a paid leave type?
  for (const e of employeeEntitlements) {
    const t = typesById.get(e.leaveTypeId)
    if (!t || !t.paid) continue
    if (e.accrualMethod !== null) return "custom"
    const resolvedDefault =
      policyByLeaveTypeId.get(e.leaveTypeId)?.defaultDays ?? t.defaultDays
    if (Math.abs(e.entitledDays - resolvedDefault) > 0.001) return "custom"
  }

  // Pass 2 — any policy override (for the employee's policy)?
  if (employeePolicyId) {
    for (const d of policyDefaults) {
      if (d.policyId !== employeePolicyId) continue
      const t = typesById.get(d.leaveTypeId)
      if (!t || !t.paid) continue
      if (d.accrualMethod !== null) return "policy"
      if (Math.abs(d.defaultDays - t.defaultDays) > 0.001) return "policy"
    }
  }

  return "default"
}

/// Pill for a policy card: shows whether this policy follows the
/// type defaults (Default, green) or has its own per-leave-type
/// overrides (Custom, red). Same colour language as the per-employee
/// `LeaveSourceBadge` below so admins read both pills the same way.
function PolicySourceBadge({ overrideCount }: { overrideCount: number }) {
  const isCustom = overrideCount > 0
  const tooltip = isCustom
    ? `This policy has ${overrideCount} per-leave-type override${
        overrideCount === 1 ? "" : "s"
      }. Employees on this policy inherit those values unless they have a per-employee override.`
    : "This policy has no overrides. Employees on it follow the leave types' org-wide defaults."
  const colorClass = isCustom
    ? "border-rose-300 bg-rose-50 text-rose-700"
    : "border-emerald-300 bg-emerald-50 text-emerald-700"
  return (
    <span
      className={
        "inline-flex items-center rounded-full border px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wide " +
        colorClass
      }
      title={tooltip}
    >
      {isCustom ? "Custom" : "Default"}
    </span>
  )
}

/// Small distinct-color pill for an employee's leave source.
/// Three states are visually separated so admins can scan a list
/// without reading every label:
///   Default — green (matches type defaults all the way up)
///   Policy  — blue  (follows the policy's overrides)
///   Custom  — red   (per-employee override exists)
///
/// Sized smaller than the standard `Supervisor` outline pill so
/// the two don't visually clash when both appear next to a name.
function LeaveSourceBadge({
  source,
  className,
}: {
  source: EmployeeLeaveSource
  className?: string
}) {
  const label =
    source === "custom"
      ? "Custom"
      : source === "policy"
        ? "Policy"
        : "Default"
  const tooltip =
    source === "custom"
      ? "Has at least one per-employee leave override (entitled days or accrual method)."
      : source === "policy"
        ? "Follows the employee's policy. Their policy has at least one leave-type override."
        : "Follows the leave type defaults. No policy or per-employee overrides apply."
  // Hard-code colours per state — the Badge primitive's variant set
  // doesn't include matching red/blue/green so we set them inline.
  // text-[9px] + tighter padding shrinks vs. the standard 10px pills.
  const colorClass =
    source === "default"
      ? "border-emerald-300 bg-emerald-50 text-emerald-700"
      : source === "policy"
        ? "border-sky-300 bg-sky-50 text-sky-700"
        : "border-rose-300 bg-rose-50 text-rose-700"
  return (
    <span
      className={
        "inline-flex items-center rounded-full border px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wide " +
        colorClass +
        (className ? ` ${className}` : "")
      }
      title={tooltip}
    >
      {label}
    </span>
  )
}

function EmployeeEntitlementRow(props: {
  employeeId: string
  leaveType: LeaveTypeRow
  year: number
  currentDays: number | null
  currentMethod: "LUMP_SUM" | "PRO_RATED" | null
  /// The method this row falls back to when the per-employee override
  /// is null — already resolved from policy → type by the caller.
  inheritedMethod: "LUMP_SUM" | "PRO_RATED"
  /// Which layer the inherited method came from. Drives the option
  /// label so the admin knows whether they'd inherit from the policy
  /// or all the way up to the leave type.
  inheritedFrom: "policy" | "type"
}) {
  const [val, setVal] = useState(
    props.currentDays !== null ? String(props.currentDays) : "",
  )
  const [pending, startTransition] = useTransition()
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function flashSaved() {
    if (savedTimer.current) clearTimeout(savedTimer.current)
    setSaved(true)
    savedTimer.current = setTimeout(() => setSaved(false), 2000)
  }

  // Reset local state when the selected employee changes.
  const lastKey = useRef<string>("")
  const key = `${props.employeeId}:${props.leaveType.id}`
  if (lastKey.current !== key) {
    lastKey.current = key
    // eslint-disable-next-line react-hooks/rules-of-hooks
    setVal(props.currentDays !== null ? String(props.currentDays) : "")
  }

  if (!props.leaveType.paid) {
    return (
      <TableRow>
        <TableCell>
          <span className="font-mono text-xs font-bold mr-2">{props.leaveType.code}</span>
          {props.leaveType.name}
        </TableCell>
        <TableCell className="text-muted-foreground">— (unpaid)</TableCell>
        <TableCell className="text-muted-foreground">—</TableCell>
        <TableCell></TableCell>
      </TableRow>
    )
  }
  const methodSelectValue: "LUMP_SUM" | "PRO_RATED" | "__DEFAULT__" =
    props.currentMethod ?? "__DEFAULT__"
  return (
    <TableRow>
      <TableCell>
        <span className="font-mono text-xs font-bold mr-2">{props.leaveType.code}</span>
        {props.leaveType.name}
      </TableCell>
      <TableCell>
        <Input
          type="number"
          step="0.5"
          min="0"
          className={
            "h-9 w-24 " + (props.currentDays !== null ? "" : "text-muted-foreground")
          }
          placeholder={`${props.leaveType.defaultDays}`}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={() => {
            const numeric = val.trim() === "" ? null : Number(val)
            if (numeric === null || numeric === props.currentDays) return
            startTransition(async () => {
              await setEmployeeEntitlementAction({
                employeeId: props.employeeId,
                leaveTypeId: props.leaveType.id,
                year: props.year,
                entitledDays: numeric,
              })
              flashSaved()
            })
          }}
          disabled={pending}
        />
      </TableCell>
      {/* ANNUAL-only PRO_RATED rule: method dropdown is only shown
          for Annual Leave. Other types render an empty cell so the
          table layout stays aligned. */}
      <TableCell>
        {props.leaveType.code.toUpperCase() === "ANNUAL" ? (
          <Select
            value={methodSelectValue}
            onValueChange={(v) => {
              const next: "LUMP_SUM" | "PRO_RATED" | null =
                v === "__DEFAULT__" ? null : (v as "LUMP_SUM" | "PRO_RATED")
              startTransition(async () => {
                await setEmployeeEntitlementAction({
                  employeeId: props.employeeId,
                  leaveTypeId: props.leaveType.id,
                  year: props.year,
                  accrualMethod: next,
                })
                flashSaved()
              })
            }}
            disabled={pending}
          >
            <SelectTrigger
              className={
                "h-9 w-44 text-sm " +
                (methodSelectValue === "__DEFAULT__"
                  ? "text-muted-foreground"
                  : "")
              }
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__DEFAULT__">
                {props.inheritedFrom === "policy"
                  ? `Inherit from policy (${
                      props.inheritedMethod === "PRO_RATED" ? "pro-rated" : "lump sum"
                    })`
                  : `Inherit from type (${
                      props.inheritedMethod === "PRO_RATED" ? "pro-rated" : "lump sum"
                    })`}
              </SelectItem>
              <SelectItem value="LUMP_SUM">Lump sum</SelectItem>
              <SelectItem value="PRO_RATED">Pro-rated</SelectItem>
            </SelectContent>
          </Select>
        ) : null}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-2">
          {saved && (
            <span className="text-xs font-medium text-emerald-600">
              ✓ Saved
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            title="Reset to inherit from policy / type"
            onClick={() =>
              startTransition(async () => {
                await resetEmployeeEntitlementAction({
                  employeeId: props.employeeId,
                  leaveTypeId: props.leaveType.id,
                  year: props.year,
                })
                setVal("")
              })
            }
          >
            Reset
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}
