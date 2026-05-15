"use client"

import { useActionState, useState } from "react"
import { Loader2, Pencil, Plus, Star, Archive } from "lucide-react"

import {
  archivePolicyAction,
  createPolicyAction,
  setDefaultPolicyAction,
  updatePolicyAction,
  type PolicyActionState,
} from "@/app/(admin)/admin/settings/policy-actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useToastOnAction } from "@/components/ui/toaster"
import { cn } from "@/lib/utils"
import {
  employeePayoutMethodLabels,
  otPayoutMethodLabels,
  type EmployeePayoutMethod,
  type OtPayoutMethod,
} from "@/modules/organization/domain/models"
import type { EmployeePolicy } from "@/modules/policy/domain/models"

type Mode =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "edit"; policy: EmployeePolicy }

const SALARY_OPTIONS: ReadonlyArray<{ value: EmployeePayoutMethod; label: string }> = [
  { value: "HOURLY", label: employeePayoutMethodLabels.HOURLY },
  { value: "MONTHLY_BASED", label: employeePayoutMethodLabels.MONTHLY_BASED },
]

type OtMode = "NONE" | OtPayoutMethod

const OT_OPTIONS: ReadonlyArray<{ value: OtMode; label: string }> = [
  { value: "NONE", label: "No OT (disabled)" },
  { value: "CASH", label: otPayoutMethodLabels.CASH },
  { value: "TIME_BANK", label: otPayoutMethodLabels.TIME_BANK },
]

const initialPolicyActionState: PolicyActionState = {
  status: "idle",
  message: "",
}

function policyToOtMode(policy: {
  otEnabled: boolean
  otMethod: OtPayoutMethod
}): OtMode {
  return policy.otEnabled ? policy.otMethod : "NONE"
}

export function EmployeePoliciesTab({
  policies,
}: {
  policies: EmployeePolicy[]
}) {
  const [mode, setMode] = useState<Mode>({ kind: "list" })

  if (mode.kind === "create") {
    return (
      <PolicyEditorCard
        title="New employee policy"
        action={createPolicyAction}
        onDone={() => setMode({ kind: "list" })}
      />
    )
  }
  if (mode.kind === "edit") {
    return (
      <PolicyEditorCard
        title={`Edit policy: ${mode.policy.name}`}
        policy={mode.policy}
        action={updatePolicyAction}
        onDone={() => setMode({ kind: "list" })}
      />
    )
  }

  return (
    <PolicyListCard
      policies={policies}
      onCreate={() => setMode({ kind: "create" })}
      onEdit={(policy) => setMode({ kind: "edit", policy })}
    />
  )
}

function PolicyListCard({
  policies,
  onCreate,
  onEdit,
}: {
  policies: EmployeePolicy[]
  onCreate: () => void
  onEdit: (policy: EmployeePolicy) => void
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Employee policies</CardTitle>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Define worker categories for this organization. Each employee is
              assigned to one policy, which decides their module access, salary
              type, and OT treatment.
            </p>
          </div>
          <Button size="sm" onClick={onCreate} className="shrink-0">
            <Plus className="mr-1 h-4 w-4" />
            New policy
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {policies.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No policies yet. Create one to start assigning employees.
          </p>
        ) : (
          <div className="space-y-3">
            {policies.map((policy) => (
              <PolicyRow key={policy.id} policy={policy} onEdit={() => onEdit(policy)} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function PolicyRow({
  policy,
  onEdit,
}: {
  policy: EmployeePolicy
  onEdit: () => void
}) {
  const [setDefaultState, setDefaultFormAction, setDefaultPending] = useActionState(
    setDefaultPolicyAction,
    initialPolicyActionState,
  )
  const [archiveState, archiveFormAction, archivePending] = useActionState(
    archivePolicyAction,
    initialPolicyActionState,
  )
  useToastOnAction(setDefaultState as PolicyActionState)
  useToastOnAction(archiveState as PolicyActionState)

  const modules = [
    policy.canAccessAttendance ? "Attendance" : null,
    policy.canAccessClaims ? "Claims" : null,
    policy.canAccessLeave ? "Leave" : null,
  ].filter(Boolean) as string[]

  return (
    <div
      className={cn(
        "rounded-[20px] border border-border/70 bg-surface-low p-4",
        policy.archived && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-foreground">{policy.name}</p>
            {policy.isDefault ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                <Star className="h-3 w-3" /> Default
              </span>
            ) : null}
            {policy.archived ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Archived
              </span>
            ) : null}
          </div>
          {policy.description ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {policy.description}
            </p>
          ) : null}
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-5">
            <div>
              <dt className="font-semibold text-foreground/80">Salary</dt>
              <dd>{employeePayoutMethodLabels[policy.salaryType]}</dd>
            </div>
            <div>
              <dt className="font-semibold text-foreground/80">OT</dt>
              <dd>
                {!policy.otEnabled
                  ? "Disabled"
                  : policy.otMethod === "CASH"
                    ? `Cash · ${policy.otRateNormalDay}× / ${policy.otRateRestDay}× / ${policy.otRatePublicHoliday}×`
                    : otPayoutMethodLabels[policy.otMethod]}
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-foreground/80">Clock-in</dt>
              <dd>
                {[
                  policy.requireGeofence ? "Geofence" : null,
                  policy.requireSelfie ? "Selfie" : null,
                ]
                  .filter(Boolean)
                  .join(" + ") || "Off"}
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-foreground/80">Modules</dt>
              <dd>{modules.length > 0 ? modules.join(", ") : "None"}</dd>
            </div>
            <div>
              <dt className="font-semibold text-foreground/80">Employees</dt>
              <dd>{policy.employeeCount ?? 0}</dd>
            </div>
          </dl>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
          </Button>
          {!policy.isDefault && !policy.archived ? (
            <form action={setDefaultFormAction}>
              <input type="hidden" name="id" value={policy.id} />
              <Button type="submit" variant="ghost" size="sm" disabled={setDefaultPending}>
                {setDefaultPending ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Star className="mr-1 h-3.5 w-3.5" />
                )}
                Set default
              </Button>
            </form>
          ) : null}
          {!policy.archived ? (
            <form action={archiveFormAction}>
              <input type="hidden" name="id" value={policy.id} />
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                disabled={archivePending}
                className="text-destructive hover:text-destructive"
              >
                {archivePending ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Archive className="mr-1 h-3.5 w-3.5" />
                )}
                Archive
              </Button>
            </form>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function PolicyEditorCard({
  title,
  policy,
  action,
  onDone,
}: {
  title: string
  policy?: EmployeePolicy
  action: (
    prev: PolicyActionState,
    formData: FormData,
  ) => Promise<PolicyActionState>
  onDone: () => void
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialPolicyActionState,
  )
  useToastOnAction(state as PolicyActionState)
  const [salaryType, setSalaryType] = useState<EmployeePayoutMethod>(
    policy?.salaryType ?? "HOURLY",
  )
  const [otMode, setOtMode] = useState<OtMode>(
    policy ? policyToOtMode(policy) : "CASH",
  )

  if (state.status === "success" && !pending) {
    // Auto-return to the list after a successful save.
    queueMicrotask(onDone)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Policies control what employees can do and how they get paid.
        </p>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-6">
          {policy ? <input type="hidden" name="id" value={policy.id} /> : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-2 text-sm font-semibold text-muted-foreground">
              <span>Policy name</span>
              <Input
                name="name"
                defaultValue={policy?.name ?? ""}
                placeholder="e.g. Hourly Worker"
                required
                disabled={pending}
              />
            </label>
            <label className="space-y-2 text-sm font-semibold text-muted-foreground sm:col-span-2">
              <span>Description (optional)</span>
              <Input
                name="description"
                defaultValue={policy?.description ?? ""}
                placeholder="Short note about who this policy applies to"
                disabled={pending}
              />
            </label>
          </div>

          <div>
            <p className="text-sm font-semibold text-foreground">Module access</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Toggle which screens employees on this policy can see.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {(["Attendance", "Claims", "Leave"] as const).map((mod) => {
                const name = `canAccess${mod}`
                const initial =
                  policy === undefined ||
                  (mod === "Attendance"
                    ? policy.canAccessAttendance
                    : mod === "Claims"
                      ? policy.canAccessClaims
                      : policy.canAccessLeave)
                return (
                  <label
                    key={mod}
                    className="flex items-center gap-2 rounded-[16px] border border-border/70 bg-surface-low px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5"
                  >
                    <input
                      type="checkbox"
                      name={name}
                      defaultChecked={initial}
                      disabled={pending}
                      className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                    />
                    <span className="font-medium text-foreground">{mod}</span>
                  </label>
                )
              })}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-2 text-sm font-semibold text-muted-foreground">
              <span>Salary type</span>
              <Select
                name="salaryType"
                value={salaryType}
                onValueChange={(v) => setSalaryType(v as EmployeePayoutMethod)}
                disabled={pending}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SALARY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs font-normal text-muted-foreground">
                Hourly workers use the hourly salary setup in payroll.
              </p>
            </label>
            <label className="space-y-2 text-sm font-semibold text-muted-foreground">
              <span>OT method</span>
              <Select
                name="otMode"
                value={otMode}
                onValueChange={(v) => setOtMode(v as OtMode)}
                disabled={pending}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OT_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs font-normal text-muted-foreground">
                Cash = paid out via payroll. Time balance = accrued as
                time-off minutes. No OT = employees on this policy cannot
                file OT at all.
              </p>
            </label>
          </div>

          {otMode === "CASH" ? (
            <div>
              <p className="text-sm font-semibold text-foreground">OT rates</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Multipliers used when computing OT pay for employees on this
                policy. ORP = monthly salary ÷ (working-days × daily working
                hours). HRP = ORP ÷ 8. Hourly workers use their per-employee
                hourly rate × the multiplier.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <RateField
                  name="otRateNormalDay"
                  label="Normal day (× HRP)"
                  defaultValue={policy?.otRateNormalDay ?? 1.5}
                  disabled={pending}
                />
                <RateField
                  name="otRateRestDay"
                  label="Rest day (× HRP)"
                  defaultValue={policy?.otRateRestDay ?? 2.0}
                  disabled={pending}
                />
                <RateField
                  name="otRatePublicHoliday"
                  label="Public holiday (× HRP)"
                  defaultValue={policy?.otRatePublicHoliday ?? 3.0}
                  disabled={pending}
                />
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <RateField
                  name="otRateRestDayInShift"
                  label="Rest day in-shift (× ORP)"
                  defaultValue={policy?.otRateRestDayInShift ?? 1.0}
                  disabled={pending}
                />
                <RateField
                  name="otRatePublicHolidayInShift"
                  label="Public holiday in-shift (× ORP)"
                  defaultValue={policy?.otRatePublicHolidayInShift ?? 2.0}
                  disabled={pending}
                />
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <RateField
                  name="otSalaryThreshold"
                  label="Salary threshold (RM, optional)"
                  step="0.01"
                  defaultValue={policy?.otSalaryThreshold ?? null}
                  placeholder="No cap"
                  disabled={pending}
                />
                <RateField
                  name="otDailyThresholdHours"
                  label="Daily OT threshold (hours)"
                  step="0.25"
                  defaultValue={(policy?.otDailyThresholdMinutes ?? 480) / 60}
                  disabled={pending}
                />
              </div>
            </div>
          ) : null}

          <div>
            <p className="text-sm font-semibold text-foreground">Clock-in checks</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Geofence radius and project location are configured per
              project. Toggle which checks this policy's employees go
              through when clocking in.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <label className="flex items-center gap-2 rounded-[16px] border border-border/70 bg-surface-low px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                <input
                  type="checkbox"
                  name="requireGeofence"
                  defaultChecked={policy?.requireGeofence ?? true}
                  disabled={pending}
                  className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                />
                <span className="font-medium text-foreground">
                  Require geofence on clock-in
                </span>
              </label>
              <label className="flex items-center gap-2 rounded-[16px] border border-border/70 bg-surface-low px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                <input
                  type="checkbox"
                  name="requireSelfie"
                  defaultChecked={policy?.requireSelfie ?? false}
                  disabled={pending}
                  className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                />
                <span className="font-medium text-foreground">
                  Require selfie on clock-in
                </span>
              </label>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              {policy ? "Save changes" : "Create policy"}
            </Button>
            <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function RateField({
  name,
  label,
  defaultValue,
  step = "0.01",
  placeholder,
  disabled,
}: {
  name: string
  label: string
  /// When null, the input renders empty — used for optional fields like
  /// the salary threshold where blank = "no cap".
  defaultValue: number | null
  step?: string
  placeholder?: string
  disabled?: boolean
}) {
  return (
    <label className="space-y-1.5 text-xs font-semibold text-muted-foreground">
      <span>{label}</span>
      <Input
        name={name}
        type="number"
        step={step}
        min="0"
        defaultValue={defaultValue ?? ""}
        placeholder={placeholder}
        disabled={disabled}
        className="h-9"
      />
    </label>
  )
}
