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

type PolicyDefault = { policyId: string; leaveTypeId: string; defaultDays: number }

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
}

type Tab = "types" | "employees"

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Leave Settings</h1>
          <p className="text-sm text-muted-foreground">
            Configure leave types, policy defaults, and per-employee entitlements for {props.year}.
          </p>
        </div>
        {tab === "types" && (
          <Button onClick={() => setEditingType("new")}>New leave type</Button>
        )}
      </div>

      <div className="flex gap-2 border-b">
        <TabButton active={tab === "types"} onClick={() => setTab("types")}>
          Leave types &amp; policies
        </TabButton>
        <TabButton active={tab === "employees"} onClick={() => setTab("employees")}>
          Employee entitlements
        </TabButton>
      </div>

      {tab === "types" && (
        <>
          <LeaveTypesCard
            leaveTypes={props.leaveTypes}
            onEdit={(t) => setEditingType(t)}
          />

          {annualType && (
            <AnnualLeaveCard annualType={annualType} />
          )}

          <PolicyDefaultsCard
            leaveTypes={activeTypes}
            policies={props.policies}
            defaults={props.policyDefaults}
          />
        </>
      )}

      {tab === "employees" && (
        <EmployeeEntitlementsTab
          year={props.year}
          leaveTypes={activeTypes}
          employees={props.employees}
          entitlements={props.employeeEntitlements}
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

function TabButton({
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
        "px-4 py-2 text-sm font-medium border-b-2 transition-colors " +
        (active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground")
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
      <CardContent>
        {props.leaveTypes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No leave types yet. Create one to get started.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2">Code</th>
                  <th>Name</th>
                  <th>Paid</th>
                  <th>Accrual</th>
                  <th>Default</th>
                  <th>Carry FWD</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {props.leaveTypes.map((t) => {
                  const isProtected = t.code.toUpperCase() === "UNPAID"
                  return (
                    <tr key={t.id} className={t.archivedAt ? "opacity-60" : ""}>
                      <td className="py-2 font-mono">{t.code}</td>
                      <td>{t.name}</td>
                      <td>{t.paid ? "Paid" : "Unpaid"}</td>
                      <td>{t.accrualMethod === "PRO_RATED" ? "Pro-rated" : "Lump sum"}</td>
                      <td>{t.paid ? t.defaultDays : "—"}</td>
                      <td>{t.carryForward ? "Yes" : "No"}</td>
                      <td className="text-right">
                        {isProtected ? (
                          <span className="text-xs text-muted-foreground">System default</span>
                        ) : (
                          <>
                            <Button variant="outline" size="sm" onClick={() => props.onEdit(t)}>
                              Edit
                            </Button>{" "}
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
                          </>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
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
// Policy defaults
// ---------------------------------------------------------------------------

function PolicyDefaultsCard(props: {
  leaveTypes: LeaveTypeRow[]
  policies: PolicyRow[]
  defaults: PolicyDefault[]
}) {
  const lookup = useMemo(() => {
    const map = new Map<string, number>()
    for (const d of props.defaults) {
      map.set(`${d.policyId}:${d.leaveTypeId}`, d.defaultDays)
    }
    return map
  }, [props.defaults])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Policy defaults</CardTitle>
        <p className="text-sm text-muted-foreground">
          Override the leave-type default per employee policy. Leave blank to fall back to the leave type's default.
        </p>
      </CardHeader>
      <CardContent>
        {props.policies.length === 0 || props.leaveTypes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Add at least one policy and leave type to configure defaults.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2">Policy</th>
                  {props.leaveTypes.map((t) => (
                    <th key={t.id}>{t.code}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {props.policies.map((p) => (
                  <tr key={p.id}>
                    <td className="py-2">{p.name}{p.isDefault ? " (default)" : ""}</td>
                    {props.leaveTypes.map((t) => (
                      <td key={t.id}>
                        <PolicyDefaultCell
                          policyId={p.id}
                          leaveTypeId={t.id}
                          paid={t.paid}
                          value={lookup.get(`${p.id}:${t.id}`) ?? null}
                          fallback={t.defaultDays}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function PolicyDefaultCell(props: {
  policyId: string
  leaveTypeId: string
  paid: boolean
  value: number | null
  fallback: number
}) {
  const [val, setVal] = useState(props.value !== null ? String(props.value) : "")
  const [pending, startTransition] = useTransition()
  if (!props.paid) {
    return <span className="text-muted-foreground">—</span>
  }
  return (
    <Input
      type="number"
      step="0.5"
      min="0"
      className="w-24"
      placeholder={String(props.fallback)}
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => {
        const numeric = val.trim() === "" ? null : Number(val)
        if (numeric === null) {
          if (props.value !== null) {
            startTransition(() =>
              clearPolicyDefaultAction({
                policyId: props.policyId,
                leaveTypeId: props.leaveTypeId,
              }),
            )
          }
          return
        }
        if (numeric === props.value) return
        startTransition(() =>
          setPolicyDefaultAction({
            policyId: props.policyId,
            leaveTypeId: props.leaveTypeId,
            defaultDays: numeric,
          }),
        )
      }}
      disabled={pending}
    />
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
}) {
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null)
  const [filter, setFilter] = useState("")

  const lookup = useMemo(() => {
    const map = new Map<string, number>()
    for (const e of props.entitlements) {
      map.set(`${e.employeeId}:${e.leaveTypeId}`, e.entitledDays)
    }
    return map
  }, [props.entitlements])

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
        <CardHeader>
          <CardTitle>Per-employee entitlements ({props.year})</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No employees yet.</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-1">
        <CardHeader>
          <CardTitle>Employees</CardTitle>
          <p className="text-sm text-muted-foreground">
            Click an employee to edit their entitlements for {props.year}.
          </p>
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
        <CardHeader>
          <CardTitle>
            {selected ? `${selected.name}'s entitlements` : "Select an employee"}
          </CardTitle>
          {selected && (
            <p className="text-sm text-muted-foreground">
              Override the policy/leave-type default for {props.year}. Reset to pull the default.
            </p>
          )}
        </CardHeader>
        <CardContent>
          {!selected ? (
            <p className="text-sm text-muted-foreground">
              Pick an employee from the list on the left.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-2">Leave type</th>
                    <th>Entitled days</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {props.leaveTypes.map((t) => (
                    <EmployeeEntitlementRow
                      key={t.id}
                      employeeId={selected.id}
                      leaveType={t}
                      year={props.year}
                      current={lookup.get(`${selected.id}:${t.id}`) ?? null}
                    />
                  ))}
                </tbody>
              </table>
            </div>
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
  current: number | null
}) {
  const [val, setVal] = useState(props.current !== null ? String(props.current) : "")
  const [pending, startTransition] = useTransition()

  // Reset local state when the selected employee changes.
  const lastKey = useRef<string>("")
  const key = `${props.employeeId}:${props.leaveType.id}`
  if (lastKey.current !== key) {
    lastKey.current = key
    // eslint-disable-next-line react-hooks/rules-of-hooks
    setVal(props.current !== null ? String(props.current) : "")
  }

  if (!props.leaveType.paid) {
    return (
      <tr>
        <td className="py-2">{props.leaveType.code} — {props.leaveType.name}</td>
        <td className="text-muted-foreground">— (unpaid)</td>
        <td></td>
      </tr>
    )
  }
  return (
    <tr>
      <td className="py-2">{props.leaveType.code} — {props.leaveType.name}</td>
      <td>
        <Input
          type="number"
          step="0.5"
          min="0"
          className="w-28"
          placeholder={String(props.leaveType.defaultDays)}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={() => {
            const numeric = val.trim() === "" ? null : Number(val)
            if (numeric === null || numeric === props.current) return
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
      </td>
      <td>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
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
          Reset to default
        </Button>
      </td>
    </tr>
  )
}
