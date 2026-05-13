"use client"

import { useActionState, useMemo, useState } from "react"
import { Plus, Trash2 } from "lucide-react"

import {
  archivePayrollProfileAction,
  deletePayrollDocumentAction,
  savePayrollEmploymentAction,
  savePayrollPersonalAction,
  savePayrollStatutoryAction,
  unarchivePayrollProfileAction,
  uploadPayrollDocumentAction,
} from "@/app/(admin)/admin/payroll/employees/[id]/actions"
import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import {
  NativeSelect,
  Toggle,
} from "@/components/admin/payroll-form-controls"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmSubmitButton } from "@/components/ui/confirm-action-dialog"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { useToastOnAction } from "@/components/ui/toaster"
import { cn } from "@/lib/utils"
import { isMalaysianNationality } from "@/modules/payroll/domain/calc"
import {
  ID_TYPE_LABELS,
  MARITAL_STATUS_LABELS,
  PAYROLL_ADJUSTMENT_CATEGORY_META,
  PAYMENT_METHOD_LABELS,
  payrollAdjustmentCategoryGroups,
  payrollAdjustmentCategories,
  SALARY_TYPE_LABELS,
  SOCSO_SCHEME_LABELS,
  childAbilityStatuses,
  childPcbDeductionLevels,
  childStudyingLevels,
  genders,
  idTypes,
  maritalStatuses,
  paymentMethods,
  salaryTypes,
  socsoSchemes,
  type ChildRelief,
  type FixedAllowance,
  type PayrollDocument,
  type PayrollProfileData,
} from "@/modules/payroll/domain/models"

type Tab = "personal" | "employment" | "statutory"

const PERSONAL_COMPLETION_FIELDS: Array<keyof PayrollProfileData> = [
  "gender",
  "dateOfBirth",
  "nationality",
  "idType",
  "idNumber",
  "maritalStatus",
  "addressLine1",
  "city",
  "postcode",
  "state",
]

export function PayrollEmployeeDetail(props: {
  userId: string
  identity: {
    name: string
    employeeId: string
    email: string
    jobTitle: string
  }
  profile: PayrollProfileData | null
  defaultEpfEmployerRate: number
}) {
  const [tab, setTab] = useState<Tab>("personal")
  const personalComplete = isPersonalTabComplete(props.profile)
  const employmentComplete = isEmploymentTabComplete(props.profile)
  const statutoryComplete = isStatutoryTabComplete(props.profile)

  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-3 border-y border-border/60 py-5">
        <TabPill
          active={tab === "personal"}
          complete={personalComplete}
          onClick={() => setTab("personal")}
        >
          Personal
        </TabPill>
        <TabPill
          active={tab === "employment"}
          complete={employmentComplete}
          onClick={() => setTab("employment")}
        >
          Employment
        </TabPill>
        <TabPill
          active={tab === "statutory"}
          complete={statutoryComplete}
          onClick={() => setTab("statutory")}
        >
          Statutory
        </TabPill>
      </nav>

      {tab === "personal" && (
        <PersonalTab userId={props.userId} profile={props.profile} />
      )}
      {tab === "employment" && (
        <EmploymentTab userId={props.userId} profile={props.profile} />
      )}
      {tab === "statutory" && (
        <StatutoryTab
          userId={props.userId}
          profile={props.profile}
          defaultEpfEmployerRate={props.defaultEpfEmployerRate}
        />
      )}

      <ArchiveCard userId={props.userId} profile={props.profile} />
    </div>
  )
}

function hasValue(value: unknown) {
  return typeof value === "string" ? value.trim().length > 0 : value != null
}

function isPersonalTabComplete(profile: PayrollProfileData | null) {
  if (!profile) return false

  return PERSONAL_COMPLETION_FIELDS.every((field) => hasValue(profile[field]))
}

function isEmploymentTabComplete(profile: PayrollProfileData | null) {
  if (!profile) return false

  if (!profile.joinDate) return false
  if (
    profile.salaryType === "MONTHLY" &&
    (profile.monthlySalary == null || profile.monthlySalary <= 0)
  ) {
    return false
  }
  if (
    profile.salaryType === "HOURLY" &&
    (profile.hourlyRate == null || profile.hourlyRate <= 0)
  ) {
    return false
  }

  return true
}

function isStatutoryTabComplete(profile: PayrollProfileData | null) {
  if (!profile) return false

  if (profile.contributeToEpf && !profile.epfNumber) return false
  if (profile.socsoScheme && !profile.socsoNumber) return false
  if (!profile.incomeTaxNumber) return false

  return true
}

function TabPill({
  active,
  complete,
  onClick,
  children,
}: {
  active: boolean
  complete: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "min-w-36 rounded-full border px-6 py-2.5 text-left transition",
        active
          ? "border-primary bg-primary text-primary-foreground shadow-sm"
          : "border-border/70 bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
      )}
    >
      <span className="block text-sm font-semibold leading-tight">{children}</span>
      <span
        className={cn(
          "mt-0.5 block text-[11px] font-medium leading-tight",
          active ? "text-primary-foreground/75" : "text-muted-foreground",
          !complete && "opacity-0",
        )}
      >
        Completed
      </span>
    </button>
  )
}

// ─── Personal tab ─────────────────────────────────────────────────────────

function PersonalTab(props: {
  userId: string
  profile: PayrollProfileData | null
}) {
  const [state, action, pending] = useActionState(
    savePayrollPersonalAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  const [children, setChildren] = useState<ChildRelief[]>(
    props.profile?.childRelief ?? [],
  )

  // Track marital status so the Spouse card can show/hide
  // instantly when the admin changes the dropdown — no save needed.
  const [maritalStatus, setMaritalStatus] = useState<string>(
    props.profile?.maritalStatus ?? "",
  )
  const showSpouseCard = maritalStatus === "MARRIED"

  // Spouse-working is required when married (drives PCB joint-relief
  // calc). Track it live so the red border clears the moment the
  // admin picks Yes / No.
  const [spouseWorking, setSpouseWorking] = useState<string>(
    booleanString(props.profile?.spouseWorking),
  )
  const spouseWorkingMissing = showSpouseCard && spouseWorking === ""

  function addChild() {
    setChildren((c) => [
      ...c,
      {
        age: 0,
        abilityStatus: "NORMAL",
        currentlyStudying: "NONE",
        pcbDeduction: "NONE",
      },
    ])
  }
  function removeChild(i: number) {
    setChildren((c) => c.filter((_, idx) => idx !== i))
  }
  function patchChild(i: number, patch: Partial<ChildRelief>) {
    setChildren((c) =>
      c.map((entry, idx) => (idx === i ? { ...entry, ...patch } : entry)),
    )
  }

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="userId" value={props.userId} hidden />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Personal details</CardTitle>
          <CardDescription>
            Identification, contact, and family info used for payslip
            generation and future PCB filing.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Phone">
            <Input
              name="phone"
              defaultValue={props.profile?.phone ?? ""}
              placeholder="+60 12 345 6789"
            />
          </Field>
          <Field label="Alternate email">
            <Input
              name="alternateEmail"
              type="email"
              defaultValue={props.profile?.alternateEmail ?? ""}
            />
          </Field>
          <Field label="Gender">
            <NativeSelect
              name="gender"
              defaultValue={props.profile?.gender ?? ""}
            >
              <option value="">—</option>
              {genders.map((g) => (
                <option key={g} value={g}>
                  {g.charAt(0) + g.slice(1).toLowerCase()}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Date of birth">
            <Input
              name="dateOfBirth"
              type="date"
              defaultValue={props.profile?.dateOfBirth ?? ""}
            />
          </Field>
          <Field label="Nationality">
            <Input
              name="nationality"
              defaultValue={props.profile?.nationality ?? "Malaysian"}
              placeholder="Malaysian"
            />
          </Field>
          <Field label="Race (LHDN code)">
            <Input
              name="race"
              defaultValue={props.profile?.race ?? ""}
              placeholder="M / C / I / O"
            />
          </Field>
          <Field label="ID type">
            <NativeSelect
              name="idType"
              defaultValue={props.profile?.idType ?? "NRIC"}
            >
              <option value="">—</option>
              {idTypes.map((t) => (
                <option key={t} value={t}>
                  {ID_TYPE_LABELS[t]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="ID number">
            <Input
              name="idNumber"
              defaultValue={props.profile?.idNumber ?? ""}
            />
          </Field>
          <Field label="Marital status">
            <NativeSelect
              name="maritalStatus"
              value={maritalStatus}
              onChange={(e) => setMaritalStatus(e.target.value)}
            >
              <option value="">—</option>
              {maritalStatuses.map((m) => (
                <option key={m} value={m}>
                  {MARITAL_STATUS_LABELS[m]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Toggle
            name="hasPr"
            question="Permanent Resident?"
            defaultChecked={props.profile?.hasPr ?? false}
          />
          <Toggle
            name="isResident"
            question="Resident (tax)?"
            defaultChecked={props.profile?.isResident ?? true}
          />
          <Toggle
            name="isOku"
            question="OKU (disabled)?"
            defaultChecked={props.profile?.isOku ?? false}
          />
        </CardContent>
      </Card>

      {showSpouseCard && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Spouse</CardTitle>
            <CardDescription>
              Optional. Used for future PCB joint-relief calc.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <Field label="Spouse working?">
              <NativeSelect
                name="spouseWorking"
                value={spouseWorking}
                onChange={(e) => setSpouseWorking(e.target.value)}
                className={cn(
                  spouseWorkingMissing &&
                    "border-destructive bg-destructive/5 ring-2 ring-destructive/30",
                )}
              >
                <option value="">—</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </NativeSelect>
            </Field>
            <Field label="Spouse disabled (OKU)?">
              <NativeSelect
                name="spouseDisabled"
                defaultValue={booleanString(props.profile?.spouseDisabled)}
              >
                <option value="">—</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </NativeSelect>
            </Field>
            <Field label="Spouse PCB number">
              <Input
                name="spousePcbNumber"
                defaultValue={props.profile?.spousePcbNumber ?? ""}
              />
            </Field>
            <Field label="Spouse ID number">
              <Input
                name="spouseIdNumber"
                defaultValue={props.profile?.spouseIdNumber ?? ""}
              />
            </Field>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Address</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Address line 1" className="md:col-span-2">
            <Input
              name="addressLine1"
              defaultValue={props.profile?.addressLine1 ?? ""}
            />
          </Field>
          <Field label="Address line 2" className="md:col-span-2">
            <Input
              name="addressLine2"
              defaultValue={props.profile?.addressLine2 ?? ""}
            />
          </Field>
          <Field label="Address line 3" className="md:col-span-2">
            <Input
              name="addressLine3"
              defaultValue={props.profile?.addressLine3 ?? ""}
            />
          </Field>
          <Field label="City">
            <Input
              name="city"
              defaultValue={props.profile?.city ?? ""}
            />
          </Field>
          <Field label="Postcode">
            <Input
              name="postcode"
              defaultValue={props.profile?.postcode ?? ""}
            />
          </Field>
          <Field label="State">
            <Input
              name="state"
              defaultValue={props.profile?.state ?? ""}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Emergency contact</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <Field label="Name">
            <Input
              name="emergencyContactName"
              defaultValue={props.profile?.emergencyContactName ?? ""}
            />
          </Field>
          <Field label="Phone">
            <Input
              name="emergencyContactPhone"
              defaultValue={props.profile?.emergencyContactPhone ?? ""}
            />
          </Field>
          <Field label="Relation">
            <Input
              name="emergencyContactRelation"
              defaultValue={props.profile?.emergencyContactRelation ?? ""}
              placeholder="Spouse / Parent / Sibling"
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <div>
            <CardTitle className="text-base">Dependent children</CardTitle>
            <CardDescription>
              Used for v2 PCB child relief calc. Up to 10 children.
            </CardDescription>
          </div>
          <Button type="button" size="sm" variant="ghost" onClick={addChild}>
            <Plus className="h-3.5 w-3.5" />
            Add child
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {children.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No children added. Add to claim child relief in PCB.
            </p>
          ) : (
            children.map((child, i) => (
              <div
                key={i}
                className="grid items-end gap-3 rounded-lg border border-border/60 bg-muted/30 p-3 md:grid-cols-[80px_1fr_1fr_1fr_auto]"
              >
                <Field label="Age">
                  <Input
                    name={`child${i}.age`}
                    type="number"
                    min={0}
                    max={50}
                    value={String(child.age)}
                    onChange={(e) =>
                      patchChild(i, { age: Number(e.target.value) || 0 })
                    }
                  />
                </Field>
                <Field label="Ability">
                  <NativeSelect
                    name={`child${i}.abilityStatus`}
                    value={child.abilityStatus}
                    onChange={(e) =>
                      patchChild(i, {
                        abilityStatus: e.target.value as ChildRelief["abilityStatus"],
                      })
                    }
                  >
                    {childAbilityStatuses.map((s) => (
                      <option key={s} value={s}>
                        {s === "NORMAL" ? "Normal" : "Disabled"}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="Studying">
                  <NativeSelect
                    name={`child${i}.currentlyStudying`}
                    value={child.currentlyStudying}
                    onChange={(e) =>
                      patchChild(i, {
                        currentlyStudying:
                          e.target.value as ChildRelief["currentlyStudying"],
                      })
                    }
                  >
                    {childStudyingLevels.map((s) => (
                      <option key={s} value={s}>
                        {s.replace("_", " ")}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="PCB share">
                  <NativeSelect
                    name={`child${i}.pcbDeduction`}
                    value={child.pcbDeduction}
                    onChange={(e) =>
                      patchChild(i, {
                        pcbDeduction:
                          e.target.value as ChildRelief["pcbDeduction"],
                      })
                    }
                  >
                    {childPcbDeductionLevels.map((s) => (
                      <option key={s} value={s}>
                        {s === "FULL"
                          ? "100%"
                          : s === "HALF"
                            ? "50%"
                            : "None"}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => removeChild(i)}
                  title="Remove child"
                  className="text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save Personal"}
        </Button>
      </div>
    </form>
  )
}

// ─── Employment tab ───────────────────────────────────────────────────────

function EmploymentTab(props: {
  userId: string
  profile: PayrollProfileData | null
}) {
  const [state, action, pending] = useActionState(
    savePayrollEmploymentAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  const [salaryType, setSalaryType] = useState(
    props.profile?.salaryType ?? "MONTHLY",
  )
  const [allowances, setAllowances] = useState<FixedAllowance[]>(
    props.profile?.fixedAllowances ?? [],
  )

  // Live values for the required fields so we can flip the red
  // border the moment the admin starts typing. These mirror the
  // form's name= bindings so submit still picks them up via FormData.
  const [monthlySalary, setMonthlySalary] = useState(
    props.profile?.monthlySalary != null
      ? String(props.profile.monthlySalary)
      : "",
  )
  const [hourlyRate, setHourlyRate] = useState(
    props.profile?.hourlyRate != null
      ? String(props.profile.hourlyRate)
      : "",
  )
  const [joinDate, setJoinDate] = useState(props.profile?.joinDate ?? "")

  const monthlySalaryMissing =
    salaryType === "MONTHLY" && monthlySalary.trim() === ""
  const hourlyRateMissing =
    salaryType === "HOURLY" && hourlyRate.trim() === ""
  const joinDateMissing = joinDate.trim() === ""

  // Two-button entrypoint (Add allowance / Add deduction) — admin sets
  // the kind up-front so the dropdown opens with category options that
  // match their intent. They can still pick any allowance/deduction
  // sub-type from the grouped <optgroup>s within the row.
  function addAdjustment(kind: "ALLOWANCE" | "DEDUCTION") {
    const category =
      kind === "DEDUCTION" ? "deduct_salary_adjustment" : "allowance_standard"
    setAllowances((a) => [
      ...a,
      {
        category,
        name: PAYROLL_ADJUSTMENT_CATEGORY_META[category].label,
        amount: 0,
      },
    ])
  }
  function removeAllowance(i: number) {
    setAllowances((a) => a.filter((_, idx) => idx !== i))
  }
  function patchAllowance(i: number, patch: Partial<FixedAllowance>) {
    setAllowances((a) =>
      a.map((entry, idx) => (idx === i ? { ...entry, ...patch } : entry)),
    )
  }

  return (
    <div className="space-y-6">
      {/* Documents card is rendered as a sibling of the main employment
          form (not nested inside it) because the card contains its own
          upload + delete forms. Nesting <form> inside <form> is invalid
          HTML and triggers a React hydration error. */}
      <form action={action} className="space-y-6">
      <input type="hidden" name="userId" value={props.userId} hidden />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Compensation</CardTitle>
          <CardDescription>
            Salary structure used for payroll calculations.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <Field label="Salary type">
            <NativeSelect
              name="salaryType"
              value={salaryType}
              onChange={(e) =>
                setSalaryType(e.target.value as typeof salaryType)
              }
            >
              {salaryTypes.map((t) => (
                <option key={t} value={t}>
                  {SALARY_TYPE_LABELS[t]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {salaryType === "MONTHLY" ? (
            <Field label="Monthly salary (MYR)">
              <Input
                name="monthlySalary"
                type="number"
                step="0.01"
                min="0"
                value={monthlySalary}
                onChange={(e) => setMonthlySalary(e.target.value)}
                aria-invalid={monthlySalaryMissing || undefined}
              />
            </Field>
          ) : (
            <Field label="Hourly rate (MYR)">
              <Input
                name="hourlyRate"
                type="number"
                step="0.01"
                min="0"
                value={hourlyRate}
                onChange={(e) => setHourlyRate(e.target.value)}
                aria-invalid={hourlyRateMissing || undefined}
              />
            </Field>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <div>
            <CardTitle className="text-base">Fixed adjustments</CardTitle>
            <CardDescription>
              Recurring monthly additions or deductions added to every
              payroll run with the right statutory treatment.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => addAdjustment("ALLOWANCE")}
            >
              <Plus className="h-3.5 w-3.5" />
              Add allowance
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => addAdjustment("DEDUCTION")}
            >
              <Plus className="h-3.5 w-3.5" />
              Add deduction
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {allowances.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No fixed adjustments. Add one for recurring monthly
              allowances, remuneration, benefits, or deductions.
            </p>
          ) : (
            allowances.map((a, i) => (
              <FixedAdjustmentRow
                key={i}
                adjustment={a}
                index={i}
                onChange={(patch) => patchAllowance(i, patch)}
                onRemove={() => removeAllowance(i)}
              />
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Employment dates</CardTitle>
          <CardDescription>
            Join date is required for proration on partial months.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Join date">
            <Input
              name="joinDate"
              type="date"
              value={joinDate}
              onChange={(e) => setJoinDate(e.target.value)}
              aria-invalid={joinDateMissing || undefined}
            />
          </Field>
          <Field label="Leave date (last day)">
            <Input
              name="leaveDate"
              type="date"
              defaultValue={props.profile?.leaveDate ?? ""}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Previous employment (TP3)</CardTitle>
          <CardDescription>
            Optional carry-over figures for PCB estimation when an
            employee joins mid-year.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <Field label="Year">
            <Input
              name="prevEmploymentYear"
              type="number"
              min="2000"
              max="2099"
              defaultValue={props.profile?.prevEmploymentYear ?? ""}
            />
          </Field>
          <Field label="Remuneration (MYR)">
            <Input
              name="prevRemuneration"
              type="number"
              step="0.01"
              min="0"
              defaultValue={props.profile?.prevRemuneration ?? ""}
            />
          </Field>
          <Field label="EPF paid (MYR)">
            <Input
              name="prevEpf"
              type="number"
              step="0.01"
              min="0"
              defaultValue={props.profile?.prevEpf ?? ""}
            />
          </Field>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save Employment"}
        </Button>
      </div>
      </form>

      <PayrollDocumentsCard
        userId={props.userId}
        documents={props.profile?.payrollDocuments ?? []}
      />
    </div>
  )
}

function FixedAdjustmentRow({
  adjustment,
  index,
  onChange,
  onRemove,
}: {
  adjustment: FixedAllowance
  index: number
  onChange: (patch: Partial<FixedAllowance>) => void
  onRemove: () => void
}) {
  const category =
    PAYROLL_ADJUSTMENT_CATEGORY_META[adjustment.category] ??
    PAYROLL_ADJUSTMENT_CATEGORY_META.allowance_standard
  const statutory = [
    category.subjectToEpf ? "EPF" : null,
    category.subjectToSocso ? "SOCSO" : null,
    category.subjectToEis ? "EIS" : null,
    category.subjectToPcb ? "PCB" : null,
  ].filter(Boolean)
  // Filter the dropdown to the same kind the row was added as. Admin
  // clicked "Add allowance" → only earning-style categories show.
  // Clicked "Add deduction" → only deduction categories. Keeps the
  // mental model clean and removes the cross-kind switching that was
  // previously possible from a single row.
  const rowKind: "ALLOWANCE" | "DEDUCTION" =
    category.kind === "DEDUCTION" ? "DEDUCTION" : "ALLOWANCE"
  const allowedCategories = payrollAdjustmentCategories.filter((code) => {
    const m = PAYROLL_ADJUSTMENT_CATEGORY_META[code]
    if (rowKind === "DEDUCTION") return m.kind === "DEDUCTION"
    return m.kind === "ALLOWANCE"
  })

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
      <div className="grid items-end gap-3 md:grid-cols-[1.4fr_1fr_180px_auto]">
        <Field label="Category">
          <NativeSelect
            name={`allowance${index}.category`}
            value={adjustment.category}
            onChange={(e) => {
              const next = e.target.value as FixedAllowance["category"]
              onChange({
                category: next,
                name: PAYROLL_ADJUSTMENT_CATEGORY_META[next].label,
              })
            }}
          >
            {payrollAdjustmentCategoryGroups
              .filter((group) =>
                allowedCategories.some(
                  (code) =>
                    PAYROLL_ADJUSTMENT_CATEGORY_META[code].group === group,
                ),
              )
              .map((group) => (
                <optgroup key={group} label={group}>
                  {allowedCategories
                    .filter(
                      (code) =>
                        PAYROLL_ADJUSTMENT_CATEGORY_META[code].group === group,
                    )
                    .map((code) => (
                      <option key={code} value={code}>
                        {PAYROLL_ADJUSTMENT_CATEGORY_META[code].label}
                      </option>
                    ))}
                </optgroup>
              ))}
          </NativeSelect>
        </Field>
        <Field label="Display name">
          <Input
            name={`allowance${index}.name`}
            value={adjustment.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder={category.label}
          />
        </Field>
        <Field label="Amount (MYR / month)">
          <Input
            name={`allowance${index}.amount`}
            type="number"
            step="0.01"
            min="0"
            value={String(adjustment.amount)}
            onChange={(e) =>
              onChange({
                amount: Number(e.target.value) || 0,
              })
            }
          />
        </Field>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onRemove}
          className="text-destructive"
          title="Remove adjustment"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="rounded-full bg-background px-2 py-0.5 font-medium text-foreground">
          {category.kind === "DEDUCTION"
            ? category.reducesBase
              ? "Deduction - reduces base"
              : "Deduction"
            : category.kind === "REIMBURSEMENT"
              ? "Reimbursement"
              : "Earning"}
        </span>
        <span>
          Statutory: {statutory.length > 0 ? statutory.join(", ") : "none"}
        </span>
        {category.taxExemptLimit ? (
          <span>
            Tax exempt limit: RM{category.taxExemptLimit.toLocaleString()}/year
          </span>
        ) : null}
        {category.referenceOnly ? <span>Reference only</span> : null}
        {category.offsetsPcb ? <span>Offsets PCB</span> : null}
      </div>
    </div>
  )
}

// ─── Statutory tab ────────────────────────────────────────────────────────

function StatutoryTab(props: {
  userId: string
  profile: PayrollProfileData | null
  defaultEpfEmployerRate: number
}) {
  const [state, action, pending] = useActionState(
    savePayrollStatutoryAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  // Branch detection — drives the read-only employer-rate display +
  // foreign-worker banners. Same logic as the calc engine, so what
  // admins see here matches what'll actually be calculated.
  // Citizenship detection — uses the same logic as the calc engine
  // so what the admin sees here is what'll actually fire on Generate.
  // Accepts "Malaysian" / "Malaysia" / "MY" / "MYS" / BM variants,
  // case-insensitively.
  const isMalaysianCitizen = isMalaysianNationality(
    props.profile?.nationality,
  )
  const isMalaysianOrPr = isMalaysianCitizen || props.profile?.hasPr === true
  const isForeignWorker = !isMalaysianOrPr
  const epfMemberBefore1998 = props.profile?.epfMemberBefore1998 ?? false
  const isPartAEligible = isMalaysianOrPr || epfMemberBefore1998

  // Compute age once for the EPF age-60+ branch selection. The calc
  // engine does the same — keeping in sync ensures the locked display
  // matches what'll fire on Generate.
  const employeeAge = computeAge(props.profile?.dateOfBirth)
  const isAge60Plus = employeeAge >= 60

  // Live state for the required statutory fields. As the admin types
  // into each, the red `aria-invalid` border clears.
  // `contributeToEpf` uses the persisted value as the gate (Toggle is
  // uncontrolled in this codebase, so admins fix EPF requirement by
  // toggling + saving). `socsoScheme` is controlled via NativeSelect
  // so the SOCSO-number requirement reacts immediately.
  const contributeToEpfInitial = props.profile?.contributeToEpf ?? true
  const [socsoScheme, setSocsoScheme] = useState<string>(
    props.profile?.socsoScheme ?? "",
  )
  const [epfNumber, setEpfNumber] = useState(props.profile?.epfNumber ?? "")
  const [socsoNumber, setSocsoNumber] = useState(
    props.profile?.socsoNumber ?? "",
  )
  const [incomeTaxNumber, setIncomeTaxNumber] = useState(
    props.profile?.incomeTaxNumber ?? "",
  )
  const epfNumberMissing = contributeToEpfInitial && epfNumber.trim() === ""
  const socsoNumberMissing =
    socsoScheme !== "" && socsoNumber.trim() === ""
  const incomeTaxNumberMissing = incomeTaxNumber.trim() === ""

  // KWSP Third Schedule branch resolver (mirrors `pickEpfBranch` in
  // domain/calc.ts).
  let epfBranchLabel: string
  let epfEmployerText: string
  let epfEmployeeText: string
  if (!isPartAEligible) {
    // Post-Aug-1998 non-Malaysian (foreign worker).
    epfBranchLabel = "Foreign worker (post-1 Aug 1998)"
    epfEmployerText = "2% (Part F · effective Oct 2025 salary)"
    epfEmployeeText = "2%"
  } else if (isAge60Plus && isMalaysianCitizen && !props.profile?.hasPr) {
    epfBranchLabel = "Malaysian citizen, age 60+"
    epfEmployerText = "4% (Part E)"
    epfEmployeeText = "0%"
  } else if (isAge60Plus) {
    epfBranchLabel = "PR or pre-1998 Non-Malaysian, age 60+"
    epfEmployerText = "6.5%"
    epfEmployeeText = "5.5%"
  } else {
    epfBranchLabel = "Standard (under age 60)"
    epfEmployerText = formatPercent(props.defaultEpfEmployerRate)
    epfEmployeeText = `${props.profile?.epfEmployeeRate ?? 11}%`
  }

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="userId" value={props.userId} hidden />

      {isForeignWorker && (
        <Card className="border-amber-300/60 bg-amber-50/40 dark:border-amber-700/40 dark:bg-amber-950/20">
          <CardHeader>
            <CardTitle className="text-base text-amber-900 dark:text-amber-200">
              Foreign worker statutory profile
            </CardTitle>
            <CardDescription className="text-amber-900/80 dark:text-amber-200/80">
              Detected because nationality is not Malaysian and PR is not
              set.{" "}
              {epfMemberBefore1998
                ? "Pre-1998 EPF member: standard EPF rates apply (Part A / C)."
                : "EPF runs on the post-1998 non-Malaysian branch (2% / 2%, effective Oct 2025 salary)."}{" "}
              EIS doesn&apos;t apply; HRDF doesn&apos;t apply. SOCSO
              scheme should typically be &quot;Employment Injury only&quot;.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">EPF</CardTitle>
          <CardDescription>
            Employees Provident Fund. Statutory rates below come from
            EPF Act 452 (Third Schedule) — shown locked for reference.
            Voluntary contributions on top are editable.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Toggle
            name="contributeToEpf"
            question="Contributing to EPF?"
            defaultChecked={props.profile?.contributeToEpf ?? true}
          />
          <Toggle
            name="epfMemberBefore1998"
            question="EPF member before Aug 1998?"
            defaultChecked={props.profile?.epfMemberBefore1998 ?? false}
          />
          <Field label="EPF number">
            <Input
              name="epfNumber"
              value={epfNumber}
              onChange={(e) => setEpfNumber(e.target.value)}
              aria-invalid={epfNumberMissing || undefined}
            />
          </Field>
          <StatutoryDisplay
            label="Employer mandatory rate"
            value={epfEmployerText}
            note={
              isPartAEligible && !isAge60Plus
                ? `Saved org default. KWSP branch: ${epfBranchLabel}.`
                : `KWSP branch: ${epfBranchLabel}.`
            }
          />
          <StatutoryDisplay
            label="Employee mandatory rate"
            value={epfEmployeeText}
            note={
              isPartAEligible && !isAge60Plus
                ? "Standard 11%. Set 9% only when employee has filed KWSP 17A."
                : "Statutory rate for this employee's branch."
            }
          >
            {/* Hidden input keeps the value flowing to the server.
                The calc engine overrides it for non-Part-A branches,
                so this only matters when the employee is on
                MALAYSIAN_UNDER_60. */}
            <input
              type="hidden"
              name="epfEmployeeRate"
              value={String(props.profile?.epfEmployeeRate ?? 11)}
            />
          </StatutoryDisplay>
          <Field label="Employee voluntary (%)">
            <Input
              name="epfEmployeeVoluntary"
              type="number"
              step="0.01"
              min="0"
              max="100"
              defaultValue={props.profile?.epfEmployeeVoluntary ?? 0}
            />
          </Field>
          <Field label="Employer voluntary (%)">
            <Input
              name="epfEmployerVoluntary"
              type="number"
              step="0.01"
              min="0"
              max="100"
              defaultValue={props.profile?.epfEmployerVoluntary ?? 0}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">SOCSO</CardTitle>
          <CardDescription>
            Social Security Organisation. Rates below come from the
            Employees&apos; Social Security Act 1969 (Third Schedule) —
            locked. Only the scheme choice is editable.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="SOCSO scheme">
            <NativeSelect
              name="socsoScheme"
              value={socsoScheme}
              onChange={(e) => setSocsoScheme(e.target.value)}
            >
              <option value="">— Not contributing —</option>
              {socsoSchemes.map((s) => (
                <option key={s} value={s}>
                  {SOCSO_SCHEME_LABELS[s]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="SOCSO number">
            <Input
              name="socsoNumber"
              value={socsoNumber}
              onChange={(e) => setSocsoNumber(e.target.value)}
              aria-invalid={socsoNumberMissing || undefined}
              disabled={socsoScheme === ""}
              placeholder={
                socsoScheme === ""
                  ? "Pick a SOCSO scheme to enable"
                  : undefined
              }
            />
          </Field>
          <StatutoryDisplay
            label="Cat 1 — Employment Injury + Invalidity"
            value="Employer 1.75% · Employee 0.5%"
            note="Wage capped at RM 6,000 for contributions."
          />
          <StatutoryDisplay
            label="Cat 2 — Employment Injury only"
            value="Employer 1.25% · Employee 0%"
            note="Typically for foreign workers and employees aged 60+."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">EIS / SSFW</CardTitle>
          <CardDescription>
            Employment Insurance System (local Malaysian + PR only) and
            Social Security for Foreign Workers. EIS rate is fixed by
            statute — only the toggle is editable.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {isForeignWorker ? (
            // Foreign workers can't join EIS — replace the toggle with
            // a locked display + hidden input that forces `false` on
            // save, so the DB stays consistent with statutory reality.
            <StatutoryDisplay
              label="Contributing to EIS?"
              value="No — foreign workers are not eligible"
              note="Auto-saved as off; the toggle would have no effect."
            >
              <input type="hidden" name="contributeToEis" value="false" />
            </StatutoryDisplay>
          ) : (
            <Toggle
              name="contributeToEis"
              question="Contributing to EIS?"
              defaultChecked={props.profile?.contributeToEis ?? true}
            />
          )}
          <StatutoryDisplay
            label="EIS rate (auto)"
            value={
              isForeignWorker
                ? "Excluded — foreign workers cannot join EIS"
                : "Employer 0.2% · Employee 0.2%"
            }
            note={
              isForeignWorker
                ? "Replaced by SSFW for foreign workers."
                : "Wage capped at RM 6,000 for contributions."
            }
          />
          <Field label="SSFW number (foreign workers)">
            <Input
              name="ssfwNumber"
              defaultValue={props.profile?.ssfwNumber ?? ""}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">PCB (income tax)</CardTitle>
          <CardDescription>
            PCB calculation is deferred to v2. Fields captured now for
            future automation.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Income tax (PCB) number">
            <Input
              name="incomeTaxNumber"
              value={incomeTaxNumber}
              onChange={(e) => setIncomeTaxNumber(e.target.value)}
              aria-invalid={incomeTaxNumberMissing || undefined}
            />
          </Field>
          <Toggle
            name="pcbBorneByEmployer"
            question="PCB borne by employer?"
            defaultChecked={props.profile?.pcbBorneByEmployer ?? false}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bank / payout</CardTitle>
          <CardDescription>
            Where the net pay gets deposited. Captured but not yet used
            for ACH file generation.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Payment method">
            <NativeSelect
              name="paymentMethod"
              defaultValue={props.profile?.paymentMethod ?? "BANK_TRANSFER"}
            >
              {paymentMethods.map((p) => (
                <option key={p} value={p}>
                  {PAYMENT_METHOD_LABELS[p]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Bank name">
            <Input
              name="bankName"
              defaultValue={props.profile?.bankName ?? ""}
            />
          </Field>
          <Field label="Account holder name">
            <Input
              name="bankAccountHolderName"
              defaultValue={props.profile?.bankAccountHolderName ?? ""}
              placeholder="If different from employee name"
            />
          </Field>
          <Field label="Account number">
            <Input
              name="bankAccountNumber"
              defaultValue={props.profile?.bankAccountNumber ?? ""}
            />
          </Field>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save Statutory"}
        </Button>
      </div>
    </form>
  )
}

// ─── Archive card ─────────────────────────────────────────────────────────

// ─── Documents card ───────────────────────────────────────────────────────

function PayrollDocumentsCard(props: {
  userId: string
  documents: PayrollDocument[]
}) {
  const [uploadState, uploadAction, uploadPending] = useActionState(
    uploadPayrollDocumentAction,
    initialSettingsActionState,
  )
  const [deleteState, deleteAction, deletePending] = useActionState(
    deletePayrollDocumentAction,
    initialSettingsActionState,
  )
  useToastOnAction(uploadState)
  useToastOnAction(deleteState)

  const docs = props.documents

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Documents</CardTitle>
        <CardDescription>
          Upload contracts, offer letters, NDA scans, ID copies, and
          other HR documents for this employee. PDF / Word / image
          formats, max 10 MB per file.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Auto-submit on file pick — no separate "Upload" button. The
            two-step "Choose file → Upload document" pattern is just
            extra friction; the admin's intent is already clear once a
            file is selected. */}
        <form action={uploadAction} className="space-y-2">
          <input type="hidden" name="userId" value={props.userId} hidden />
          <input
            type="file"
            name="file"
            required
            disabled={uploadPending}
            accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/jpeg,image/png,image/webp,image/heic,image/heif"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                e.target.form?.requestSubmit()
              }
            }}
            className="block w-full rounded-md border border-border bg-card px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-primary/10 file:px-3 file:py-1 file:text-xs file:font-medium file:text-primary disabled:cursor-not-allowed disabled:opacity-60"
          />
          {uploadPending ? (
            <p className="text-xs text-muted-foreground">Uploading…</p>
          ) : null}
        </form>

        {docs.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No documents uploaded yet.
          </p>
        ) : (
          <div className="space-y-1.5">
            {docs.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm"
              >
                <a
                  href={doc.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-w-0 flex-col text-foreground hover:text-primary"
                >
                  <span className="truncate font-medium">{doc.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {formatBytes(doc.sizeBytes)} ·{" "}
                    {new Date(doc.uploadedAt).toLocaleString()}
                  </span>
                </a>
                <form
                  id={`delete-payroll-document-${doc.id}`}
                  action={deleteAction}
                >
                  <input
                    type="hidden"
                    name="userId"
                    value={props.userId}
                    hidden
                  />
                  <input
                    type="hidden"
                    name="documentId"
                    value={doc.id}
                    hidden
                  />
                  <ConfirmSubmitButton
                    formId={`delete-payroll-document-${doc.id}`}
                    title="Remove payroll document?"
                    description={`Remove "${doc.name}" from this employee's documents?`}
                    confirmLabel="Remove"
                    triggerLabel="Remove"
                    pendingLabel="Removing..."
                    pending={deletePending}
                    triggerSize="sm"
                    triggerVariant="ghost"
                    triggerClassName="text-destructive"
                    confirmVariant="destructive"
                  />
                </form>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function ArchiveCard(props: {
  userId: string
  profile: PayrollProfileData | null
}) {
  const [archiveState, archiveAction, archivePending] = useActionState(
    archivePayrollProfileAction,
    initialSettingsActionState,
  )
  const [unarchiveState, unarchiveAction, unarchivePending] = useActionState(
    unarchivePayrollProfileAction,
    initialSettingsActionState,
  )
  useToastOnAction(archiveState)
  useToastOnAction(unarchiveState)

  if (!props.profile) return null

  return (
    <Card className="border-border/40">
      <CardHeader>
        <CardTitle className="text-base">
          {props.profile.isArchived ? "Restore to payroll" : "Archive"}
        </CardTitle>
        <CardDescription>
          {props.profile.isArchived
            ? "This employee is currently excluded from payroll runs. Historical payslips are retained."
            : "Archiving removes this employee from future payroll runs. Their historical payslips stay accessible."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {props.profile.isArchived ? (
          <form action={unarchiveAction} className="inline-flex">
            <input type="hidden" name="userId" value={props.userId} hidden />
            <Button type="submit" variant="outline" disabled={unarchivePending}>
              {unarchivePending ? "Restoring…" : "Restore to payroll"}
            </Button>
          </form>
        ) : (
          <form action={archiveAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="userId" value={props.userId} hidden />
            <Field label="Reason (optional)" className="flex-1 min-w-[240px]">
              <Input name="reason" placeholder="Left company / contract ended" />
            </Field>
            <Button
              type="submit"
              variant="ghost"
              className="text-destructive"
              disabled={archivePending}
            >
              {archivePending ? "Archiving…" : "Archive from payroll"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Tiny field + form helpers ────────────────────────────────────────────

function Field({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}

/**
 * Read-only display for a statutory rate that admins can't change.
 * Renders a small "Locked" badge so the visual treatment differs from
 * an editable input. Accepts children for any hidden inputs that
 * still need to flow with the form.
 */
function StatutoryDisplay({
  label,
  value,
  note,
  children,
}: {
  label: string
  value: string
  note?: string
  children?: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      {/* Label format matches `Field` exactly (plain text-xs with
          leading-none) so the box below sits at the same y as
          editable Input rows in the same grid row. Badge is inline
          with vertical-align: middle so it doesn't push the line
          height. */}
      <Label className="text-xs">
        {label}
        <span className="ml-1.5 inline-block rounded-sm border border-border/70 bg-muted px-1.5 py-px align-middle text-[9px] font-semibold uppercase tracking-wide leading-none text-muted-foreground">
          Locked
        </span>
      </Label>
      {/* Matches the shared Input styling (h-12, rounded-2xl, etc.)
          so locked rows sit flush next to editable ones. Muted
          background keeps it clearly read-only. */}
      <div
        aria-readonly="true"
        className="flex h-12 w-full items-center rounded-2xl border border-border/80 bg-muted/40 px-4 py-2 text-base text-foreground shadow-sm sm:text-sm"
      >
        {value}
      </div>
      {note ? (
        <p className="text-[11px] text-muted-foreground">{note}</p>
      ) : null}
      {children}
    </div>
  )
}

/**
 * Compute the employee's current age (whole years) from an ISO date
 * string. Returns 0 when missing so unknown ages default to under-60
 * (most lenient EPF branch).
 */
function computeAge(dateOfBirth: string | null | undefined): number {
  if (!dateOfBirth) return 0
  const dob = Date.parse(dateOfBirth)
  if (Number.isNaN(dob)) return 0
  const dobDate = new Date(dob)
  const today = new Date()
  let age = today.getUTCFullYear() - dobDate.getUTCFullYear()
  const monthDelta = today.getUTCMonth() - dobDate.getUTCMonth()
  if (
    monthDelta < 0 ||
    (monthDelta === 0 && today.getUTCDate() < dobDate.getUTCDate())
  ) {
    age -= 1
  }
  return Math.max(0, age)
}

function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2)}%`
}

function booleanString(b: boolean | null | undefined): string {
  if (b === true) return "true"
  if (b === false) return "false"
  return ""
}
