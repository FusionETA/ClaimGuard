"use client"

import { useMemo, useRef, useState, useTransition } from "react"

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

export function LeaveSettingsView(props: {
  orgId: string
  year: number
  leaveTypes: LeaveTypeRow[]
  policies: PolicyRow[]
  policyDefaults: PolicyDefault[]
  employees: EmployeeRow[]
  employeeEntitlements: EmployeeEntitlement[]
}) {
  const [tab, setTab] = useState<Tab>("types")
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
          <PillTab active={tab === "types"} onClick={() => setTab("types")}>
            Leave types
          </PillTab>
          <PillTab active={tab === "policies"} onClick={() => setTab("policies")}>
            Per-policy
          </PillTab>
          <PillTab active={tab === "employees"} onClick={() => setTab("employees")}>
            Per-employee
          </PillTab>
        </div>
      </nav>

      {tab === "types" && (
        <>
          <LeaveTypesCard
            leaveTypes={props.leaveTypes}
            onEdit={(t) => setEditingType(t)}
          />
          {annualType && <AnnualLeaveCard annualType={annualType} />}
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
    case "types":
      return "Define the leave types available in this organisation — what they're called, whether they're paid, the default day count, and how they accrue."
    case "policies":
      return "Override the type defaults per employee policy. Each policy can have its own day count and accrual method per leave type."
    case "employees":
      return `Override the policy/type defaults for a specific employee for ${year}. Reset to inherit from the policy.`
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
  onEdit: (t: LeaveTypeRow) => void
}) {
  const [pending, startTransition] = useTransition()
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Paid</TableHead>
                <TableHead>Accrual</TableHead>
                <TableHead>Default</TableHead>
                <TableHead>Carry FWD</TableHead>
                <TableHead className="text-right"> </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.leaveTypes.map((t) => {
                const isProtected = t.code.toUpperCase() === "UNPAID"
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
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Annual-leave carry-forward + expiry card
// ---------------------------------------------------------------------------

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

  // Only paid leave types can carry custom day counts (unpaid leave
  // always resolves to 0); filtering here matches the matrix's old
  // behaviour and keeps each policy card focused.
  const paidTypes = props.leaveTypes.filter((t) => t.paid)

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
    <div className="space-y-4">
      {props.policies.map((p) => {
        // Quick header summary: how many overrides this policy holds.
        const overrideCount = paidTypes.filter(
          (t) => lookup.get(`${p.id}:${t.id}`) != null,
        ).length
        return (
          <Card key={p.id}>
            <CardHeader className="flex-row items-center justify-between gap-2 pb-3">
              <div>
                <CardTitle className="text-base">
                  {p.name}
                  {p.isDefault && (
                    <Badge variant="outline" className="ml-2 align-middle text-[10px]">
                      Default
                    </Badge>
                  )}
                </CardTitle>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {overrideCount === 0
                    ? "No overrides — every leave type inherits from its type default."
                    : `${overrideCount} override${overrideCount === 1 ? "" : "s"} set.`}
                </p>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Leave type</TableHead>
                    <TableHead className="w-36">Default days</TableHead>
                    <TableHead className="w-48">Accrual method</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paidTypes.map((t) => {
                    const cell = lookup.get(`${p.id}:${t.id}`) ?? null
                    return (
                      <PolicyOverrideRow
                        key={t.id}
                        policyId={p.id}
                        leaveType={t}
                        daysValue={cell?.days ?? null}
                        methodValue={cell?.method ?? null}
                      />
                    )
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )
      })}
    </div>
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
  const methodSelectValue: "LUMP_SUM" | "PRO_RATED" | "__DEFAULT__" =
    props.methodValue ?? "__DEFAULT__"
  const isOverriddenDays = props.daysValue !== null
  const isOverriddenMethod = props.methodValue !== null

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
            "h-9 w-28 " +
            (isOverriddenDays ? "" : "text-muted-foreground")
          }
          placeholder={`${props.leaveType.defaultDays} (type)`}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={() => {
            const numeric = val.trim() === "" ? null : Number(val)
            if (numeric === null) {
              // Days cleared. Keep the row alive if there's still a
              // method override; otherwise drop the row entirely.
              if (props.methodValue !== null) {
                startTransition(() =>
                  setPolicyDefaultAction({
                    policyId: props.policyId,
                    leaveTypeId: props.leaveType.id,
                    defaultDays: props.leaveType.defaultDays,
                  }),
                )
                return
              }
              if (props.daysValue !== null) {
                startTransition(() =>
                  clearPolicyDefaultAction({
                    policyId: props.policyId,
                    leaveTypeId: props.leaveType.id,
                  }),
                )
              }
              return
            }
            if (numeric === props.daysValue) return
            startTransition(() =>
              setPolicyDefaultAction({
                policyId: props.policyId,
                leaveTypeId: props.leaveType.id,
                defaultDays: numeric,
              }),
            )
          }}
          disabled={pending}
        />
      </TableCell>
      <TableCell>
        <Select
          value={methodSelectValue}
          onValueChange={(v) => {
            const next: "LUMP_SUM" | "PRO_RATED" | null =
              v === "__DEFAULT__" ? null : (v as "LUMP_SUM" | "PRO_RATED")
            startTransition(() =>
              setPolicyDefaultAction({
                policyId: props.policyId,
                leaveTypeId: props.leaveType.id,
                accrualMethod: next,
              }),
            )
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
  /// Per-policy method overrides — used to label the "Policy default"
  /// option on the per-employee method selector with what the
  /// employee's policy actually resolves to (so the admin can see what
  /// they're inheriting).
  policyDefaults: PolicyDefault[]
}) {
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null)
  const [filter, setFilter] = useState("")

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

  // (policyId × leaveTypeId) → policy-layer method override (if any).
  // Used to compute the inherited method label per row when the
  // selected employee has a policy.
  const policyMethodLookup = useMemo(() => {
    const map = new Map<string, "LUMP_SUM" | "PRO_RATED" | null>()
    for (const d of props.policyDefaults) {
      map.set(`${d.policyId}:${d.leaveTypeId}`, d.accrualMethod)
    }
    return map
  }, [props.policyDefaults])

  const filteredEmployees = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return props.employees
    return props.employees.filter(
      (e) =>
        e.name.toLowerCase().includes(needle) ||
        e.email.toLowerCase().includes(needle),
    )
  }, [props.employees, filter])

  const selected = selectedEmployeeId
    ? props.employees.find((e) => e.id === selectedEmployeeId) ?? null
    : null

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
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-1">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Employees{" "}
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              ({props.employees.length})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Input
            placeholder="Search by name or email"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="mb-3"
          />
          <div className="max-h-[500px] overflow-y-auto divide-y rounded-xl border">
            {filteredEmployees.length === 0 ? (
              <div className="p-3 text-sm text-muted-foreground">No matches.</div>
            ) : (
              filteredEmployees.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => setSelectedEmployeeId(e.id)}
                  className={
                    "w-full text-left px-3 py-2 text-sm transition-colors hover:bg-muted " +
                    (selectedEmployeeId === e.id ? "bg-muted font-medium" : "")
                  }
                >
                  <div>{e.name}</div>
                  <div className="text-xs text-muted-foreground">{e.email}</div>
                </button>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {selected ? selected.name : "Select an employee"}
          </CardTitle>
          {selected && (
            <p className="text-xs text-muted-foreground">
              {selected.email} · Overrides for {props.year}
            </p>
          )}
        </CardHeader>
        <CardContent className={selected ? "p-0" : ""}>
          {!selected ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Pick an employee on the left to edit their leave entitlements.
            </p>
          ) : (
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
                  const cell = lookup.get(`${selected.id}:${t.id}`) ?? null
                  // The "Inherit" option's label shows what this row
                  // would resolve to without a per-employee override —
                  // policy-layer method (if set) then type method.
                  const policyOverride = selected.policyId
                    ? (policyMethodLookup.get(
                        `${selected.policyId}:${t.id}`,
                      ) ?? null)
                    : null
                  const inheritedMethod = policyOverride ?? t.accrualMethod
                  // Whether the inherited method came from a policy
                  // override (vs. directly from the type). Drives the
                  // label so the admin knows which layer they're
                  // falling back to.
                  const inheritedFrom: "policy" | "type" =
                    policyOverride != null ? "policy" : "type"
                  return (
                    <EmployeeEntitlementRow
                      key={t.id}
                      employeeId={selected.id}
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
          )}
        </CardContent>
      </Card>
    </div>
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
            startTransition(() =>
              setEmployeeEntitlementAction({
                employeeId: props.employeeId,
                leaveTypeId: props.leaveType.id,
                year: props.year,
                entitledDays: numeric,
              }),
            )
          }}
          disabled={pending}
        />
      </TableCell>
      <TableCell>
        <Select
          value={methodSelectValue}
          onValueChange={(v) => {
            const next: "LUMP_SUM" | "PRO_RATED" | null =
              v === "__DEFAULT__" ? null : (v as "LUMP_SUM" | "PRO_RATED")
            startTransition(() =>
              setEmployeeEntitlementAction({
                employeeId: props.employeeId,
                leaveTypeId: props.leaveType.id,
                year: props.year,
                accrualMethod: next,
              }),
            )
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
      </TableCell>
      <TableCell className="text-right">
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
      </TableCell>
    </TableRow>
  )
}
