"use client"

import { useActionState, useEffect, useMemo, useRef, useState } from "react"
import { ArrowRight, Plus, Trash2 } from "lucide-react"

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
import {
  EmployeeCompanyForm,
  type EmployeeCompanyData,
} from "@/components/admin/employee-company-form"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { NATIONALITIES } from "@/lib/nationalities"
import { isMalaysianNationality } from "@/modules/payroll/domain/calc"
import {
  EPF_RELIEF_CAP,
  SOCSO_EIS_RELIEF_CAP,
  calcResidentReliefsBreakdown,
} from "@/modules/payroll/domain/pcb"
import {
  lookupEis,
  lookupSocso,
} from "@/modules/payroll/domain/statutory-tables"
import {
  SALARY_CHANGE_REASONS,
  SALARY_CHANGE_REASON_LABELS,
  computeRaisePercent,
  type SalaryChangeData,
  type SalaryChangeReason,
} from "@/modules/payroll/domain/salary-change"
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
  isEmploymentTabComplete,
  isPersonalTabComplete,
  isStatutoryTabComplete,
  maritalStatuses,
  paymentMethods,
  salaryTypes,
  socsoSchemes,
  type ChildRelief,
  type FixedAllowance,
  type PayrollDocument,
  type PayrollProfileData,
} from "@/modules/payroll/domain/models"
import {
  EMPLOYEE_FORM_KINDS,
  EMPLOYEE_FORM_META,
  isEmployeeFormAvailable,
  type EmployeeFormKind,
} from "@/modules/payroll/domain/employee-forms"

type Tab = "personal" | "employment" | "statutory" | "company"

/**
 * Seed the live-mirror copy with the same defaults the Personal-tab
 * dropdowns DISPLAY when the saved profile is blank. Without this, the
 * tab pill stays red even though the dropdowns visibly read "Malaysian"
 * / "NRIC" — because the admin never had to touch them, the form's
 * onChange never fired, and `liveProfile.nationality` / `idType`
 * remained null. The fix: pre-fill them in the mirror to match the UI.
 */
function withPersonalUiDefaults(
  profile: PayrollProfileData | null,
): PayrollProfileData | null {
  if (!profile) return profile
  return {
    ...profile,
    nationality:
      profile.nationality && profile.nationality.trim().length > 0
        ? profile.nationality
        : "Malaysian",
    idType: profile.idType ?? "NRIC",
  }
}

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
  salaryHistory: SalaryChangeData[]
  /// Org-hierarchy editing context. Null only when the member couldn't
  /// be resolved (defensive) — in that case the Company tab is hidden.
  company: EmployeeCompanyData | null
}) {
  const [tab, setTab] = useState<Tab>("personal")
  // Mirror the profile in state so the tab-pill highlight clears AS
  // THE ADMIN TYPES, instead of waiting for a save. Inputs stay
  // uncontrolled (no cursor jumps) — this is just a derived mirror.
  // We seed with the Personal-tab dropdown UI defaults (Malaysian /
  // NRIC) so the pill matches what the admin SEES on the form.
  const [liveProfile, setLiveProfile] = useState<PayrollProfileData | null>(
    () => withPersonalUiDefaults(props.profile),
  )
  useEffect(() => {
    setLiveProfile(withPersonalUiDefaults(props.profile))
  }, [props.profile])
  // Single delegated form-level change handler used by every tab's
  // form (PersonalTab / EmploymentTab / StatutoryTab pass it as
  // `onLiveChange`). Coerces checkbox values to booleans and the few
  // numeric fields the completion checks compare against; everything
  // else stays a string.
  function handleLiveProfileChange(
    event: React.ChangeEvent<HTMLFormElement>,
  ) {
    const t = event.target as unknown as
      | HTMLInputElement
      | HTMLSelectElement
      | HTMLTextAreaElement
      | null
    if (!t || !t.name) return
    const name = t.name
    const isCheckbox = (t as HTMLInputElement).type === "checkbox"
    const numericFields = new Set(["monthlySalary", "hourlyRate"])
    let value: string | number | boolean | null = t.value
    if (isCheckbox) {
      value = (t as HTMLInputElement).checked
    } else if (numericFields.has(name)) {
      const raw = t.value.trim()
      value = raw === "" ? null : Number(raw)
    }
    setLiveProfile((prev) =>
      ({
        ...(prev ?? ({} as PayrollProfileData)),
        [name]: value,
      } as PayrollProfileData),
    )
  }
  // No profile row at all → every tab is "incomplete" (admin hasn't
  // started onboarding yet). The three completion helpers take a
  // non-null profile so we early-return false here.
  const personalComplete = liveProfile
    ? isPersonalTabComplete(liveProfile)
    : false
  const employmentComplete = liveProfile
    ? isEmploymentTabComplete(liveProfile)
    : false
  const statutoryComplete = liveProfile
    ? isStatutoryTabComplete(liveProfile)
    : false

  // Resolve the employee's assigned policy so the Employment tab's
  // Compensation card can lock the salary type to it. The policy uses
  // PayoutMethod (HOURLY | MONTHLY_BASED); map to the profile's
  // SalaryType (HOURLY | MONTHLY). Null when no policy is assigned.
  const assignedPolicy = props.company?.policies.find(
    (p) => p.id === props.company?.member.policyId,
  )
  const policySalaryType: "MONTHLY" | "HOURLY" | null =
    assignedPolicy?.salaryType === "MONTHLY_BASED"
      ? "MONTHLY"
      : assignedPolicy?.salaryType === "HOURLY"
        ? "HOURLY"
        : null

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
        {props.company ? (
          <TabPill
            active={tab === "company"}
            complete={(props.company.member.projects?.length ?? 0) > 0}
            onClick={() => setTab("company")}
          >
            Company
          </TabPill>
        ) : null}
      </nav>

      {tab === "personal" && (
        <PersonalTab
          userId={props.userId}
          email={props.identity.email}
          // Pass the LIVE mirror so the tab's own inline red helpers
          // also update as the admin types — not just the tab pill.
          profile={liveProfile}
          onLiveChange={handleLiveProfileChange}
        />
      )}
      {tab === "employment" && (
        <EmploymentTab
          userId={props.userId}
          profile={liveProfile}
          salaryHistory={props.salaryHistory}
          policySalaryType={policySalaryType}
          policyName={assignedPolicy?.name ?? null}
          // Only offer the "assign a policy" shortcut when the Company
          // tab actually exists (company context resolved).
          onAssignPolicy={props.company ? () => setTab("company") : undefined}
          onLiveChange={handleLiveProfileChange}
        />
      )}
      {tab === "statutory" && (
        <StatutoryTab
          userId={props.userId}
          profile={liveProfile}
          defaultEpfEmployerRate={props.defaultEpfEmployerRate}
          onLiveChange={handleLiveProfileChange}
        />
      )}
      {tab === "company" && props.company ? (
        <EmployeeCompanyForm {...props.company} />
      ) : null}

      <LhdnFormsCard userId={props.userId} profile={props.profile} />
      <ArchiveCard userId={props.userId} profile={props.profile} />
    </div>
  )
}

/**
 * LHDN Forms card — per-employee statutory PDFs generated on demand.
 *
 * The five forms surfaced here are independent of the org-wide annual
 * forms tab (which handles Form EA / Form E / CP8D). These are the
 * per-employee events: new-hire notification (CP22), cessation
 * (CP22A), leaving Malaysia (CP21), handover to next employer (TP3),
 * and the on-request PCB statement (PCB 2(II)).
 *
 * Buttons download directly via a plain `<a href download>` pointing
 * at the API route; no client-side state mutation, no `<Link>` (which
 * would hang on a file response with no RSC payload).
 *
 * Year picker only shows for forms whose `needsYearPicker` is true.
 * Active/archived gating is enforced both in the UI (button disabled)
 * AND server-side in `generateEmployeeForm` — UI is a hint, the
 * service is the authority.
 */
function LhdnFormsCard(props: {
  userId: string
  profile: PayrollProfileData | null
}) {
  const [year, setYear] = useState<number>(new Date().getFullYear())
  if (!props.profile) return null
  const isArchived = props.profile.isArchived

  return (
    <Card className="border-border/40">
      <CardHeader>
        <CardTitle className="text-base">LHDN Forms</CardTitle>
        <CardDescription>
          Per-employee statutory PDFs. Each summarises the LHDN-required
          fields in an AltomateHR layout — transcribe onto the official
          LHDN form before submission, or paste values into e-PCB.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="lhdn-form-year" className="text-xs">
              Year (for year-scoped forms)
            </Label>
            <Input
              id="lhdn-form-year"
              type="number"
              min={2000}
              max={2100}
              step={1}
              value={year}
              onChange={(e) => {
                const next = Number.parseInt(e.target.value, 10)
                if (Number.isFinite(next)) setYear(next)
              }}
              className="w-32"
            />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {EMPLOYEE_FORM_KINDS.map((kind) => (
            <LhdnFormButton
              key={kind}
              kind={kind}
              userId={props.userId}
              year={year}
              isArchived={isArchived}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function LhdnFormButton(props: {
  kind: EmployeeFormKind
  userId: string
  year: number
  isArchived: boolean
}) {
  const meta = EMPLOYEE_FORM_META[props.kind]
  const available = isEmployeeFormAvailable({
    kind: props.kind,
    isArchived: props.isArchived,
  })
  // Each commit flips the relevant form's "implemented" flag once its
  // renderer + service dispatch is wired up. Keep this list in sync
  // with the switch in `generateEmployeeForm()` — buttons for unwired
  // forms render as "Coming soon".
  const implementedKinds: EmployeeFormKind[] = ["PCB2II", "CP22"]
  const implemented = implementedKinds.includes(props.kind)
  const enabled = available && implemented

  const reason = !implemented
    ? "Coming soon"
    : !available
      ? meta.requires === "ARCHIVED_ONLY"
        ? "Available after archiving"
        : "Available only for active employees"
      : null

  const href = enabled
    ? `/api/admin/payroll/employee-forms/${props.userId}?kind=${props.kind}&year=${props.year}`
    : undefined

  return (
    <div
      className={cn(
        "rounded-lg border border-border/60 bg-card p-3",
        enabled ? "" : "opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">{meta.code}</span>
            <Badge variant="outline" className="text-[10px]">
              {meta.title}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {meta.description}
          </p>
          {reason ? (
            <p className="mt-1.5 text-[11px] font-medium text-amber-600">
              {reason}
            </p>
          ) : null}
        </div>
        <Button
          asChild={enabled}
          variant="outline"
          size="sm"
          disabled={!enabled}
          className="shrink-0"
        >
          {enabled ? (
            // Plain anchor — file downloads must not go through Next's
            // <Link> (no RSC payload to mount = infinite "Rendering…").
            <a href={href} download>
              Download PDF
            </a>
          ) : (
            <span>Download PDF</span>
          )}
        </Button>
      </div>
    </div>
  )
}

function hasValue(value: unknown) {
  return typeof value === "string" ? value.trim().length > 0 : value != null
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
  // When the tab still has required fields blank, ring the pill in red
  // and show a tiny red dot in the corner — at-a-glance signal for the
  // admin that this tab is what's blocking "ready to payroll".
  // Clears the moment every required field is filled.
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative min-w-36 rounded-full border px-6 py-2.5 text-left transition",
        active
          ? "border-primary bg-primary text-primary-foreground shadow-sm"
          : "border-border/70 bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
        !complete && !active && "border-destructive/60 ring-1 ring-destructive/30",
        !complete && active && "ring-2 ring-destructive/50",
      )}
    >
      {!complete ? (
        <span
          aria-hidden
          className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-destructive"
        />
      ) : null}
      <span className="block text-sm font-semibold leading-tight">{children}</span>
      <span
        className={cn(
          "mt-0.5 block text-[11px] font-medium leading-tight",
          complete
            ? active
              ? "text-primary-foreground/75"
              : "text-muted-foreground"
            : "text-destructive",
        )}
      >
        {complete ? "Completed" : "Required fields missing"}
      </span>
    </button>
  )
}

// ─── Personal tab ─────────────────────────────────────────────────────────

function PersonalTab(props: {
  userId: string
  /// Current primary (login) email. Rendered as an editable field below
  /// — admins can change it; uniqueness is enforced server-side via the
  /// `User.email` unique constraint.
  email: string
  profile: PayrollProfileData | null
  /// Fires on every input/select change so the parent can mirror form
  /// values in state and update the tab-pill highlight live.
  onLiveChange?: (event: React.ChangeEvent<HTMLFormElement>) => void
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

  // Nationality drives PR + tax-resident: a Malaysian citizen is always
  // a permanent resident and a tax resident, so when nationality is
  // Malaysian we force both ON and lock them. Track live so the toggles
  // react the instant the admin changes the dropdown.
  const [nationality, setNationality] = useState<string>(
    props.profile?.nationality ?? "Malaysian",
  )
  const isMalaysian = isMalaysianNationality(nationality)
  const [hasPr, setHasPr] = useState<boolean>(props.profile?.hasPr ?? false)
  const [isResident, setIsResident] = useState<boolean>(
    props.profile?.isResident ?? true,
  )
  // Locked-on display values when Malaysian; otherwise the admin's pick.
  const prChecked = isMalaysian ? true : hasPr
  const residentChecked = isMalaysian ? true : isResident
  // Build the dropdown options, preserving any legacy free-text value
  // that isn't in our canonical list so it still shows + round-trips.
  const nationalityOptions =
    nationality && !NATIONALITIES.includes(nationality as never)
      ? [nationality, ...NATIONALITIES]
      : NATIONALITIES

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
    <form action={action} className="space-y-6" onChange={props.onLiveChange}>
      <input type="hidden" name="userId" value={props.userId} hidden />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Personal details</CardTitle>
          <CardDescription>
            Identification, contact, and family info used for payslip
            generation, PCB reliefs, and LHDN filing.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Email (login)">
            <Input
              name="email"
              type="email"
              defaultValue={props.email}
              required
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Used to sign in. Changing it logs the employee out at next
              session; the current session stays valid.
            </p>
          </Field>
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
            {!hasValue(props.profile?.gender) ? (
              <p className="mt-1 text-xs font-medium text-destructive">
                Required.
              </p>
            ) : null}
          </Field>
          <Field label="Date of birth">
            <Input
              name="dateOfBirth"
              type="date"
              defaultValue={props.profile?.dateOfBirth ?? ""}
              aria-invalid={!hasValue(props.profile?.dateOfBirth) || undefined}
            />
            {!hasValue(props.profile?.dateOfBirth) ? (
              <p className="mt-1 text-xs font-medium text-destructive">
                Required — drives EIS age gating.
              </p>
            ) : null}
          </Field>
          <Field label="Nationality">
            <NativeSelect
              name="nationality"
              value={nationality}
              onChange={(e) => setNationality(e.target.value)}
            >
              {nationalityOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </NativeSelect>
            {!hasValue(nationality) ? (
              <p className="mt-1 text-xs font-medium text-destructive">
                Required.
              </p>
            ) : null}
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
            {!hasValue(props.profile?.idType) ? (
              <p className="mt-1 text-xs font-medium text-destructive">
                Required for PCB / SOCSO+EIS file generation.
              </p>
            ) : null}
          </Field>
          <Field label="ID number">
            <Input
              name="idNumber"
              defaultValue={props.profile?.idNumber ?? ""}
              aria-invalid={!hasValue(props.profile?.idNumber) || undefined}
            />
            {!hasValue(props.profile?.idNumber) ? (
              <p className="mt-1 text-xs font-medium text-destructive">
                Required for PCB / SOCSO+EIS file generation.
              </p>
            ) : null}
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
            {!hasValue(maritalStatus) ? (
              <p className="mt-1 text-xs font-medium text-destructive">
                Required — drives PCB spouse / child relief calc.
              </p>
            ) : null}
          </Field>
          <Toggle
            name="hasPr"
            question="Permanent Resident?"
            checked={prChecked}
            disabled={isMalaysian}
            onCheckedChange={setHasPr}
            hint={
              isMalaysian
                ? "Locked on — Malaysian citizens are permanent residents."
                : undefined
            }
          />
          <Toggle
            name="isResident"
            question="Resident (tax)?"
            checked={residentChecked}
            disabled={isMalaysian}
            onCheckedChange={setIsResident}
            hint={
              isMalaysian
                ? "Locked on — Malaysian citizens are tax residents."
                : undefined
            }
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
              Drives the PCB spouse reliefs (S RM 4,000 + SU RM 6,000) — applied only when the spouse has no source of income.
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
              aria-invalid={!hasValue(props.profile?.addressLine1) || undefined}
            />
            {!hasValue(props.profile?.addressLine1) ? (
              <p className="mt-1 text-xs font-medium text-destructive">
                Required — appears on payslip and LHDN filings.
              </p>
            ) : null}
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
              aria-invalid={!hasValue(props.profile?.city) || undefined}
            />
            {!hasValue(props.profile?.city) ? (
              <p className="mt-1 text-xs font-medium text-destructive">
                Required.
              </p>
            ) : null}
          </Field>
          <Field label="Postcode">
            <Input
              name="postcode"
              defaultValue={props.profile?.postcode ?? ""}
              aria-invalid={!hasValue(props.profile?.postcode) || undefined}
            />
            {!hasValue(props.profile?.postcode) ? (
              <p className="mt-1 text-xs font-medium text-destructive">
                Required.
              </p>
            ) : null}
          </Field>
          <Field label="State">
            <Input
              name="state"
              defaultValue={props.profile?.state ?? ""}
              aria-invalid={!hasValue(props.profile?.state) || undefined}
            />
            {!hasValue(props.profile?.state) ? (
              <p className="mt-1 text-xs font-medium text-destructive">
                Required.
              </p>
            ) : null}
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
              Used for PCB child relief (QC). Up to 10 children.
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
  salaryHistory: SalaryChangeData[]
  /// Salary type governed by the employee's assigned policy (mapped to
  /// the profile's SalaryType). Null when no policy is assigned — the
  /// salary-type field then stays editable as a legacy fallback.
  policySalaryType: "MONTHLY" | "HOURLY" | null
  /// Assigned policy name, for the read-only hint. Null when unassigned.
  policyName: string | null
  /// Jumps to the Company tab so the admin can assign a policy. Undefined
  /// when there's no Company tab (company context unavailable).
  onAssignPolicy?: () => void
  /// Fires on every input/select change so the parent can mirror form
  /// values in state and update the tab-pill highlight live.
  onLiveChange?: (event: React.ChangeEvent<HTMLFormElement>) => void
}) {
  const [state, action, pending] = useActionState(
    savePayrollEmploymentAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  const [salaryType, setSalaryType] = useState(
    props.profile?.salaryType ?? "MONTHLY",
  )

  // Salary type is governed by the employee's assigned policy (passed in
  // as `policySalaryType`) — it is NOT edited here.
  const { policySalaryType } = props

  // Keep the submitted salary type in lock-step with the policy so the
  // hidden input, dirty-tracking, and the salary-change dialog all use
  // the policy-governed value.
  useEffect(() => {
    if (policySalaryType && salaryType !== policySalaryType) {
      setSalaryType(policySalaryType)
    }
  }, [policySalaryType, salaryType])

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

  // Salary-change classification dialog. When the admin clicks Save:
  //   1. We diff the live salary values against the saved snapshot.
  //   2. If they're unchanged, the form submits silently.
  //   3. If they changed, we open the dialog forcing the admin to
  //      classify as Typo (no audit row) or Real change (with reason
  //      + effective date + notes). The form submits after they pick.
  const [salaryDialogOpen, setSalaryDialogOpen] = useState(false)
  const [salaryChangeKind, setSalaryChangeKind] = useState<
    "TYPO" | SalaryChangeReason | null
  >(null)
  const [salaryChangeEffectiveDate, setSalaryChangeEffectiveDate] = useState(
    () => new Date().toISOString().slice(0, 10),
  )
  const [salaryChangeNotes, setSalaryChangeNotes] = useState("")
  const pendingFormRef = useRef<HTMLFormElement | null>(null)

  function salaryHasChanged(): boolean {
    const savedType = props.profile?.salaryType ?? "MONTHLY"
    if (salaryType !== savedType) return true
    const savedMonthly =
      props.profile?.monthlySalary != null
        ? String(props.profile.monthlySalary)
        : ""
    if (salaryType === "MONTHLY" && monthlySalary !== savedMonthly) return true
    const savedHourly =
      props.profile?.hourlyRate != null
        ? String(props.profile.hourlyRate)
        : ""
    if (salaryType === "HOURLY" && hourlyRate !== savedHourly) return true
    return false
  }

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
      <form
        ref={pendingFormRef}
        action={action}
        className="space-y-6"
        onChange={props.onLiveChange}
        onSubmit={(e) => {
          // Intercept the very first submit attempt when the salary
          // actually changed. We open the classification dialog and
          // let the admin pick TYPO vs a real reason; the second
          // submit (from the dialog's "Save" button) is allowed
          // through because `salaryChangeKind` will have been set.
          if (salaryHasChanged() && salaryChangeKind === null) {
            e.preventDefault()
            setSalaryDialogOpen(true)
          }
        }}
      >
      <input type="hidden" name="userId" value={props.userId} hidden />
      <input
        type="hidden"
        name="salaryChangeKind"
        value={salaryChangeKind ?? ""}
      />
      <input
        type="hidden"
        name="salaryChangeEffectiveDate"
        value={
          salaryChangeKind && salaryChangeKind !== "TYPO"
            ? salaryChangeEffectiveDate
            : ""
        }
      />
      <input
        type="hidden"
        name="salaryChangeNotes"
        value={
          salaryChangeKind && salaryChangeKind !== "TYPO"
            ? salaryChangeNotes
            : ""
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Compensation</CardTitle>
          <CardDescription>
            Salary structure used for payroll calculations.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <Field label="Salary type">
            {policySalaryType ? (
              // Governed by the assigned policy — read-only here. The
              // hidden input still submits the value.
              <>
                <input type="hidden" name="salaryType" value={salaryType} />
                <div className="flex h-9 items-center justify-between gap-2 rounded-md border border-input bg-muted/40 px-3 text-sm">
                  <span className="font-medium">
                    {SALARY_TYPE_LABELS[policySalaryType]}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    From policy
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                  Set by the assigned policy
                  {props.policyName ? ` (${props.policyName})` : ""}. Change it
                  in the Company tab.
                </p>
              </>
            ) : props.onAssignPolicy ? (
              // No policy assigned yet. Salary type is governed by the
              // policy, so guide the admin to assign one rather than
              // letting them set a type that the policy will override.
              <>
                <input type="hidden" name="salaryType" value={salaryType} />
                <div className="flex h-9 items-center justify-between gap-2 rounded-md border border-dashed border-input bg-muted/20 px-3 text-sm">
                  <span className="text-muted-foreground">No policy assigned</span>
                </div>
                <button
                  type="button"
                  onClick={props.onAssignPolicy}
                  className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline"
                >
                  Assign a policy in the Company tab
                  <ArrowRight className="h-3 w-3" />
                </button>
              </>
            ) : (
              // True legacy fallback (no Company tab) — keep it editable.
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
            )}
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
              {monthlySalaryMissing ? (
                <p className="mt-1 text-xs font-medium text-destructive">
                  Required.
                </p>
              ) : null}
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
              {hourlyRateMissing ? (
                <p className="mt-1 text-xs font-medium text-destructive">
                  Required.
                </p>
              ) : null}
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
            {joinDateMissing ? (
              <p className="mt-1 text-xs font-medium text-destructive">
                Required — drives proration on first-month payroll.
              </p>
            ) : null}
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
          <Field label="PCB paid (MYR)">
            <Input
              name="prevPcb"
              type="number"
              step="0.01"
              min="0"
              defaultValue={props.profile?.prevPcb ?? ""}
            />
          </Field>
          <Field label="Zakat paid (MYR)">
            <Input
              name="prevZakat"
              type="number"
              step="0.01"
              min="0"
              defaultValue={props.profile?.prevZakat ?? ""}
            />
          </Field>
          <Field label="Allowable deductions (TP1, MYR)">
            <Input
              name="prevAllowableDeductions"
              type="number"
              step="0.01"
              min="0"
              defaultValue={props.profile?.prevAllowableDeductions ?? ""}
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

      <SalaryHistoryCard history={props.salaryHistory} />

      <PayrollDocumentsCard
        userId={props.userId}
        documents={props.profile?.payrollDocuments ?? []}
      />

      <SalaryChangeDialog
        open={salaryDialogOpen}
        onOpenChange={(next) => {
          setSalaryDialogOpen(next)
          if (!next) setSalaryChangeKind(null)
        }}
        previousSalaryType={props.profile?.salaryType ?? "MONTHLY"}
        previousMonthlySalary={props.profile?.monthlySalary ?? null}
        previousHourlyRate={props.profile?.hourlyRate ?? null}
        newSalaryType={salaryType}
        newMonthlySalary={monthlySalary}
        newHourlyRate={hourlyRate}
        kind={salaryChangeKind}
        setKind={setSalaryChangeKind}
        effectiveDate={salaryChangeEffectiveDate}
        setEffectiveDate={setSalaryChangeEffectiveDate}
        notes={salaryChangeNotes}
        setNotes={setSalaryChangeNotes}
        onConfirm={() => {
          // Close the dialog and re-submit the form. The next submit
          // sees `salaryChangeKind !== null` so the intercept lets
          // it through.
          setSalaryDialogOpen(false)
          // requestSubmit() lets the action fire via the standard
          // React useActionState pipeline (vs .submit() which bypasses it).
          pendingFormRef.current?.requestSubmit()
        }}
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
  /// Fires on every input/select change so the parent can mirror form
  /// values in state and update the tab-pill highlight live.
  onLiveChange?: (event: React.ChangeEvent<HTMLFormElement>) => void
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
  // domain/calc.ts). Where the employer rate cliff at RM 5,000 applies,
  // we resolve it against the saved monthly salary so the admin sees
  // exactly which rate will fire on Generate.
  const persistedWage = props.profile?.monthlySalary ?? 0
  const wageAtOrBelowCliff = persistedWage > 0 && persistedWage <= 5000
  const wageAboveCliff = persistedWage > 5000
  let epfBranchLabel: string
  let epfEmployerText: string
  let epfEmployeeText: string
  if (!isPartAEligible) {
    // Post-Aug-1998 non-Malaysian (foreign worker).
    epfBranchLabel = "Foreign worker (post-1 Aug 1998) — Part F"
    epfEmployerText = "2% (effective Oct 2025 salary)"
    epfEmployeeText = "2%"
  } else if (isAge60Plus && isMalaysianCitizen && !props.profile?.hasPr) {
    epfBranchLabel = "Malaysian citizen, age 60+ — Part E"
    epfEmployerText = "4%"
    epfEmployeeText = "0%"
  } else if (isAge60Plus) {
    epfBranchLabel = "PR or pre-1998 Non-Malaysian, age 60+ — Part C"
    // Part C cliff: 6.5% (≤ RM 5,000) / 6% (> RM 5,000)
    if (wageAtOrBelowCliff) {
      epfEmployerText = "6.5% (salary ≤ RM 5,000)"
    } else if (wageAboveCliff) {
      epfEmployerText = "6% (salary > RM 5,000)"
    } else {
      epfEmployerText = "6.5% (≤ RM 5,000) or 6% (> RM 5,000)"
    }
    epfEmployeeText = "5.5%"
  } else {
    epfBranchLabel = "Standard (under age 60) — Part A"
    // Part A cliff: 13% (≤ RM 5,000) / 12% (> RM 5,000)
    if (wageAtOrBelowCliff) {
      epfEmployerText = "13% (salary ≤ RM 5,000)"
    } else if (wageAboveCliff) {
      epfEmployerText = "12% (salary > RM 5,000)"
    } else {
      epfEmployerText = "13% (≤ RM 5,000) or 12% (> RM 5,000)"
    }
    // Statutory minimum is 11%; the previously-supported 9% election
    // ended after COVID. KWSP 17A i-TOPUP now only allows ABOVE-statutory
    // contributions (capture those via "Employee voluntary").
    epfEmployeeText = "11%"
  }

  return (
    <form action={action} className="space-y-6" onChange={props.onLiveChange}>
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
              EIS DOES apply (Act 800 covers foreign workers on valid
              permits, age 18–60). HRDF does NOT apply (PSMB Act Sec. 2
              limits to Malaysian citizens). SOCSO scheme should
              typically be &quot;Employment Injury only&quot;.
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
            {epfNumberMissing ? (
              <p className="mt-1 text-xs font-medium text-destructive">
                Required when EPF contributions are enabled.
              </p>
            ) : null}
          </Field>
          <StatutoryDisplay
            label="Employer mandatory rate"
            value={epfEmployerText}
            note={`KWSP branch: ${epfBranchLabel}.`}
          />
          <StatutoryDisplay
            label="Employee mandatory rate"
            value={epfEmployeeText}
            note={
              isPartAEligible && !isAge60Plus
                ? "Statutory minimum 11%. The COVID-era 9% election has ended; use \"Employee voluntary\" below to capture above-statutory contributions (KWSP 17A i-TOPUP)."
                : "Statutory rate for this employee's branch."
            }
          >
            {/* Hidden input keeps the value flowing to the server.
                The calc engine clamps it to a minimum of 11% on Part
                A and overrides it entirely on other branches. */}
            <input
              type="hidden"
              name="epfEmployeeRate"
              value={String(
                Math.max(11, props.profile?.epfEmployeeRate ?? 11),
              )}
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
            {socsoNumberMissing ? (
              <p className="mt-1 text-xs font-medium text-destructive">
                Required when a SOCSO scheme is selected.
              </p>
            ) : null}
          </Field>
          {(() => {
            // Resolve which SOCSO category will actually fire on
            // Generate based on the profile. Cat 2 (employer-only)
            // applies to employees aged 60+ or foreign workers; Cat 1
            // for everyone else who's contributing.
            const cat2Will =
              socsoScheme === "EMPLOYMENT_INJURY_ONLY" ||
              isAge60Plus ||
              isForeignWorker
            const willFire = socsoScheme === "" ? null : cat2Will ? "cat2" : "cat1"
            return (
              <>
                <StatutoryDisplay
                  label="Cat 1 — Employment Injury + Invalidity"
                  value="Employer 1.75% · Employee 0.5%"
                  note={
                    willFire === "cat1"
                      ? "✓ This will apply for this employee — wage capped at RM 6,000."
                      : "For employees under 60 (Malaysian, PR, or with valid permit). Wage capped at RM 6,000."
                  }
                />
                <StatutoryDisplay
                  label="Cat 2 — Employment Injury only"
                  value="Employer 1.25% · Employee 0%"
                  note={
                    willFire === "cat2"
                      ? `✓ This will apply for this employee — ${
                          isAge60Plus
                            ? "age 60+"
                            : isForeignWorker
                              ? "foreign worker"
                              : "scheme set to Injury Only"
                        }.`
                      : "Typically for foreign workers and employees aged 60+."
                  }
                />
              </>
            )
          })()}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">EIS / SSFW</CardTitle>
          <CardDescription>
            Employment Insurance System (Act 800). Applies to all
            employees aged 18–60 — Malaysian citizens, PR holders, and
            foreign workers on valid permits. EIS rate is fixed by
            statute — only the toggle is editable. SSFW number is for
            foreign workers separately.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Toggle
            name="contributeToEis"
            question="Contributing to EIS?"
            defaultChecked={props.profile?.contributeToEis ?? true}
          />
          {(() => {
            // EIS gating: 18 ≤ age < 60. Below 18 or 60+ → no
            // contribution even if the toggle is on. Match the calc
            // engine exactly so the preview matches Generate.
            //
            // The rate row stays visible regardless of the toggle so
            // the admin can always see what statutory rate would
            // apply if they turned it on; the `value` text reflects
            // whether it'll actually fire on the next run.
            const ageBelow18 =
              props.profile?.dateOfBirth != null && employeeAge < 18
            const age60Plus = isAge60Plus
            const ageOk = !ageBelow18 && !age60Plus
            const willFire =
              (props.profile?.contributeToEis ?? true) && ageOk
            return (
              <StatutoryDisplay
                label="EIS rate (auto)"
                value={
                  willFire
                    ? "Employer 0.2% · Employee 0.2%"
                    : "Not applied this run"
                }
                note={
                  age60Plus
                    ? "Employee is 60+ — EIS contributions cease at age 60."
                    : ageBelow18
                      ? "Employee is under 18 — EIS applies from age 18."
                      : !(props.profile?.contributeToEis ?? true)
                        ? "Toggle is off — EIS will not be deducted."
                        : "Wage capped at RM 6,000 (Act 800 Third Schedule)."
                }
              />
            )
          })()}
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
          <CardTitle className="text-base">HRDF (HRD Corp levy)</CardTitle>
          <CardDescription>
            Per PSMB Act Sec. 2, the HRD Corp levy applies to Malaysian
            citizens only. The org-level levy rate is set in Payroll
            Settings; this card shows whether this employee will be
            included on the next run.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <StatutoryDisplay
            label="Levy applies to this employee?"
            value={isMalaysianCitizen ? "Yes" : "No"}
            note={
              isMalaysianCitizen
                ? "Malaysian citizen — levy applied at the org's HRDF rate (1.0% or 0.5% per Settings)."
                : props.profile?.hasPr
                  ? "PR holder — HRDF excludes PR per PSMB Act Sec. 2 (\"employee\" = citizen of Malaysia)."
                  : "Foreign worker — HRDF doesn't apply."
            }
          />
          <StatutoryDisplay
            label="Levy wage base"
            value="Basic + fixed allowances + leave pay + arrears"
            note="Excludes travel allowance, gratuity, bonus, commission, BIK, and reimbursements (PSMB Act Sec. 2)."
          />
        </CardContent>
      </Card>

      {/* Zakat pendapatan is handled entirely through the monthly
          deduction categories now — add a "Zakat — via salary deduction
          (PZB)" or "Zakat — self-paid (TP1)" line on the run. No
          per-employee zakat card / race detection. */}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">PCB (income tax)</CardTitle>
          <CardDescription>
            Monthly Tax Deduction per LHDN MTD Specification for 2026.
            Capture the LHDN tax number for the CP39 submission file
            (the calc still runs without it).
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
            {incomeTaxNumberMissing ? (
              <p className="mt-1 text-xs font-medium text-destructive">
                Required for PCB TXT generation.
              </p>
            ) : null}
          </Field>
          {/* "PCB borne by employer" toggle removed — the gross-up
              calculation is listed in the "Upcoming features" card
              on the payroll landing page. The schema field stays so
              we can wire it back when gross-up ships. A hidden input
              keeps the existing persisted value flowing to the
              server on save so older records aren't silently flipped
              to false. */}
          <input
            type="hidden"
            name="pcbBorneByEmployer"
            value={props.profile?.pcbBorneByEmployer ? "true" : ""}
          />
          <StatutoryDisplay
            label="Tax residency"
            value={
              props.profile?.isResident
                ? "Resident — progressive tax bands + reliefs"
                : "Non-resident — flat 30% of taxable remuneration"
            }
            note={
              props.profile?.isResident
                ? "Annualised normal-remuneration formula plus AR delta for one-off bonus/commission."
                : "No personal reliefs. Set in the Personal tab via the \"Resident\" toggle."
            }
          />
          <StatutoryDisplay
            label="Calculation status"
            value={
              incomeTaxNumberMissing
                ? "Will run, but TIN missing"
                : "Will run normally"
            }
            note={
              incomeTaxNumberMissing
                ? "LHDN MTD spec does not gate calculation on TIN — PCB will still be computed. The TIN is required only for the CP39 submission file, so add it before submitting to LHDN."
                : "PCB will be computed using YTD income/EPF/zakat/PCB carryover from prior SUBMITTED payslips (plus TP3 prev-employer figures if same year)."
            }
          />
          {props.profile?.isResident
            ? (() => {
                // Resolved annual reliefs that will be subtracted from
                // chargeable income. We split into:
                //
                //   1. Family / personal reliefs (D + S + DU + SU + ΣQC)
                //      — derived purely from profile state, identical
                //      every month of the year.
                //   2. Contribution-based reliefs auto-applied inside
                //      the PCB calc — EPF (capped RM 4,000) and the
                //      combined SOCSO + EIS (capped RM 350). These are
                //      estimates based on the current monthly salary
                //      annualised; the real calc uses YTD figures from
                //      submitted payslips.
                //
                // Zakat offsets PCB owed directly (not chargeable
                // income), so it's not in this sum.
                const breakdown = calcResidentReliefsBreakdown({
                  isOku: props.profile?.isOku ?? false,
                  spouseWorking: props.profile?.spouseWorking ?? null,
                  spouseDisabled: props.profile?.spouseDisabled ?? null,
                  childRelief: props.profile?.childRelief ?? [],
                })
                const spouseClaimable =
                  props.profile?.spouseWorking === false

                // ── Estimated EPF relief ─────────────────────────────
                // Annual EPF employee contribution = monthly × 12,
                // capped at the LHDN RM 4,000/year relief ceiling.
                // Uses the profile's employee rate, falling back to
                // 11% when unset. Only counted when the employee
                // actually contributes to EPF.
                const monthly = props.profile?.monthlySalary ?? 0
                const epfEmpRate = props.profile?.epfEmployeeRate || 11
                const estEpfMonth =
                  props.profile?.contributeToEpf && monthly > 0
                    ? monthly * (epfEmpRate / 100)
                    : 0
                const estEpfRelief = Math.min(
                  EPF_RELIEF_CAP,
                  Math.round(estEpfMonth * 12 * 100) / 100,
                )

                // ── Annual SOCSO + EIS relief ────────────────────────
                // Auto-applied (see SOCSO_EIS_RELIEF_CAP doc in pcb.ts
                // for the "soft TP1" rationale). Uses the actuals-only
                // formula: at year-end, total relief = min(RM 350,
                // sum of monthly contributions). For this preview we
                // show the year-end ceiling — `min(350, monthly × 12)`
                // — which is what the employee will end up benefiting
                // from across the year. The PCB calc applies it
                // gradually month-by-month (no forward projection),
                // so the actual monthly impact starts small and grows
                // until the cap is hit.
                const cat2 =
                  props.profile?.socsoScheme === "EMPLOYMENT_INJURY_ONLY"
                const socsoMonth = props.profile?.socsoScheme
                  ? lookupSocso(monthly, cat2).employee
                  : 0
                const eisMonth = props.profile?.contributeToEis
                  ? lookupEis(monthly).employee
                  : 0
                const estSocsoEisRelief = Math.min(
                  SOCSO_EIS_RELIEF_CAP,
                  Math.round((socsoMonth + eisMonth) * 12 * 100) / 100,
                )

                const items: Array<{
                  label: string
                  amount: number
                  reason?: string
                }> = [
                  {
                    label: "Individual (D)",
                    amount: breakdown.individual,
                  },
                  {
                    label: "Disabled individual (DU)",
                    amount: breakdown.disabledIndividual,
                    reason:
                      breakdown.disabledIndividual === 0
                        ? "employee not OKU"
                        : undefined,
                  },
                  {
                    label: "Spouse (S)",
                    amount: breakdown.spouse,
                    reason:
                      breakdown.spouse === 0
                        ? props.profile?.spouseWorking === true
                          ? "spouse is working"
                          : props.profile?.spouseWorking == null
                            ? "spouse working status not set"
                            : undefined
                        : undefined,
                  },
                  {
                    label: "Disabled spouse (SU)",
                    amount: breakdown.disabledSpouse,
                    reason:
                      breakdown.disabledSpouse === 0
                        ? !spouseClaimable
                          ? "spouse-relief gate is closed"
                          : props.profile?.spouseDisabled !== true
                            ? "spouse not marked disabled"
                            : undefined
                        : undefined,
                  },
                ]
                const childCount = breakdown.childItems.length
                const qualifyingCount = breakdown.childItems.filter(
                  (a) => a > 0,
                ).length
                items.push({
                  label:
                    childCount === 0
                      ? "Children (QC)"
                      : `Children (QC) — ${qualifyingCount} of ${childCount} qualifying`,
                  amount: breakdown.children,
                  reason:
                    breakdown.children === 0
                      ? childCount === 0
                        ? "no children entered"
                        : "no qualifying children"
                      : undefined,
                })
                items.push({
                  label: "EPF (auto, capped RM 4,000)",
                  amount: estEpfRelief,
                  reason:
                    estEpfRelief === 0
                      ? !props.profile?.contributeToEpf
                        ? "employee opted out of EPF"
                        : monthly === 0
                          ? "monthly salary not set"
                          : undefined
                      : estEpfRelief >= EPF_RELIEF_CAP
                        ? "at cap — annual contribution exceeds RM 4,000"
                        : "estimate based on this month's salary × 12",
                })
                items.push({
                  label: "SOCSO + EIS (auto, capped RM 350)",
                  amount: estSocsoEisRelief,
                  reason:
                    estSocsoEisRelief === 0
                      ? !props.profile?.socsoScheme &&
                        !props.profile?.contributeToEis
                        ? "not covered by SOCSO or EIS"
                        : monthly === 0
                          ? "monthly salary not set"
                          : undefined
                      : estSocsoEisRelief >= SOCSO_EIS_RELIEF_CAP
                        ? "at cap — annual contribution exceeds RM 350"
                        : "estimate based on this month's salary × 12",
                })
                const totalAllReliefs =
                  breakdown.total + estEpfRelief + estSocsoEisRelief
                return (
                  <div className="md:col-span-2">
                    <StatutoryDisplay
                      label="Annual reliefs (PCB chargeable income deduction)"
                      value={`RM ${totalAllReliefs.toLocaleString("en-MY", { minimumFractionDigits: 0 })}`}
                      note={
                        <div className="space-y-0.5 text-xs">
                          {items.map((it) => (
                            <div
                              key={it.label}
                              className="flex items-baseline justify-between gap-3"
                            >
                              <span className={it.amount === 0 ? "text-muted-foreground/70" : ""}>
                                {it.label}
                                {it.reason ? (
                                  <span className="ml-1 text-[10px] italic text-muted-foreground/70">
                                    — {it.reason}
                                  </span>
                                ) : null}
                              </span>
                              <span
                                className={
                                  it.amount === 0
                                    ? "font-mono text-muted-foreground/70"
                                    : "font-mono"
                                }
                              >
                                RM {it.amount.toLocaleString("en-MY")}
                              </span>
                            </div>
                          ))}
                          <p className="mt-1 text-[11px]">
                            Per LHDN MTD Spec 2026: spouse reliefs (S
                            and SU) apply only when spouse has no
                            income. EPF + SOCSO/EIS figures are
                            estimates from this month&apos;s salary
                            × 12 — the real PCB run uses YTD figures
                            from submitted payslips. Zakat is not
                            shown here because it offsets PCB owed
                            directly (after the tax bands), not
                            chargeable income. Update spouse / OKU /
                            children in the Personal tab to change
                            family reliefs.
                          </p>
                        </div>
                      }
                    />
                  </div>
                )
              })()
            : null}
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
          <form action={archiveAction} className="space-y-3">
            <input type="hidden" name="userId" value={props.userId} hidden />
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Last working day" className="min-w-[180px]">
                <Input
                  name="leaveDate"
                  type="date"
                  required
                  // Pre-fill from any existing leaveDate the admin set on
                  // the Employment card, otherwise today. Admin can still
                  // edit before submitting.
                  defaultValue={
                    props.profile.leaveDate ??
                    new Date().toISOString().slice(0, 10)
                  }
                />
              </Field>
              <Field label="Reason (optional)" className="flex-1 min-w-[240px]">
                <Input
                  name="reason"
                  placeholder="Left company / contract ended"
                />
              </Field>
              <Button
                type="submit"
                variant="ghost"
                className="text-destructive"
                disabled={archivePending}
              >
                {archivePending ? "Archiving…" : "Archive from payroll"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The final pay run is prorated to the last working day —
              e.g. a 20 May leave date still pays for 1–20 May, then
              excludes the employee from June onwards.
            </p>
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

// ─── Salary change dialog + history card ────────────────────────────────

/**
 * Modal shown the moment an admin clicks "Save Employment" while the
 * salary value differs from the persisted snapshot. Forces them to
 * classify the change so we can record an audit-grade history row.
 */
function SalaryChangeDialog(props: {
  open: boolean
  onOpenChange: (next: boolean) => void
  previousSalaryType: "MONTHLY" | "HOURLY"
  previousMonthlySalary: number | null
  previousHourlyRate: number | null
  newSalaryType: "MONTHLY" | "HOURLY"
  newMonthlySalary: string
  newHourlyRate: string
  kind: "TYPO" | SalaryChangeReason | null
  setKind: (k: "TYPO" | SalaryChangeReason) => void
  effectiveDate: string
  setEffectiveDate: (d: string) => void
  notes: string
  setNotes: (n: string) => void
  onConfirm: () => void
}) {
  const oldText =
    props.previousSalaryType === "MONTHLY"
      ? `RM ${(props.previousMonthlySalary ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2 })} / mo`
      : `RM ${(props.previousHourlyRate ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2 })} / hr`
  const newText =
    props.newSalaryType === "MONTHLY"
      ? `RM ${(Number(props.newMonthlySalary) || 0).toLocaleString("en-MY", { minimumFractionDigits: 2 })} / mo`
      : `RM ${(Number(props.newHourlyRate) || 0).toLocaleString("en-MY", { minimumFractionDigits: 2 })} / hr`

  const isRealChange = props.kind !== null && props.kind !== "TYPO"

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Why is the salary changing?</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-foreground">{oldText}</span>{" "}
            → <span className="font-mono text-foreground">{newText}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-border/70 bg-card p-3 text-sm transition hover:border-primary/40">
            <input
              type="radio"
              name="salary-change-kind"
              checked={props.kind === "TYPO"}
              onChange={() => props.setKind("TYPO")}
              className="mt-0.5"
            />
            <div>
              <div className="font-medium text-foreground">
                Typo / data-entry correction
              </div>
              <p className="text-xs text-muted-foreground">
                No history entry created. Use this when the previous
                value was just a mistake.
              </p>
            </div>
          </label>

          <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-border/70 bg-card p-3 text-sm transition hover:border-primary/40">
            <input
              type="radio"
              name="salary-change-kind"
              checked={isRealChange}
              onChange={() => props.setKind("RAISE")}
              className="mt-0.5"
            />
            <div className="flex-1">
              <div className="font-medium text-foreground">
                Real change (raise, promotion, restructure)
              </div>
              <p className="text-xs text-muted-foreground">
                Recorded in the salary history for audit, HR review,
                and Industrial Relations purposes.
              </p>
              {isRealChange ? (
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Reason">
                      <NativeSelect
                        value={props.kind ?? "RAISE"}
                        onChange={(e) =>
                          props.setKind(e.target.value as SalaryChangeReason)
                        }
                      >
                        {SALARY_CHANGE_REASONS.map((r) => (
                          <option key={r} value={r}>
                            {SALARY_CHANGE_REASON_LABELS[r]}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                    <Field label="Effective from">
                      <Input
                        type="date"
                        value={props.effectiveDate}
                        onChange={(e) =>
                          props.setEffectiveDate(e.target.value)
                        }
                      />
                    </Field>
                  </div>
                  <Field label="Notes (optional)">
                    <Input
                      value={props.notes}
                      onChange={(e) => props.setNotes(e.target.value)}
                      placeholder="e.g. Annual review 2026 / Q3 promotion"
                    />
                  </Field>
                </div>
              ) : null}
            </div>
          </label>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={props.kind === null}
            onClick={props.onConfirm}
          >
            Save salary change
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Read-only timeline of legitimate salary changes for the employee.
 * Empty state: render nothing — admins don't need to see "no history
 * yet" noise on every new hire.
 */
function SalaryHistoryCard({ history }: { history: SalaryChangeData[] }) {
  if (history.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Salary history</CardTitle>
        <CardDescription>
          Audit trail of legitimate compensation changes. Typo
          corrections are NOT listed here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {history.map((change) => {
          const pct = computeRaisePercent(change)
          const oldText =
            change.previousSalaryType === "MONTHLY"
              ? `RM ${(change.previousMonthlySalary ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2 })} / mo`
              : `RM ${(change.previousHourlyRate ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2 })} / hr`
          const newText =
            change.newSalaryType === "MONTHLY"
              ? `RM ${(change.newMonthlySalary ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2 })} / mo`
              : `RM ${(change.newHourlyRate ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2 })} / hr`
          return (
            <div
              key={change.id}
              className="rounded-2xl border border-border/70 bg-card p-3 text-sm"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="font-medium text-foreground">
                  {SALARY_CHANGE_REASON_LABELS[change.reason]}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    Effective {change.effectiveDate}
                  </span>
                </div>
                {pct !== null ? (
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                      pct >= 0
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
                        : "bg-destructive/15 text-destructive",
                    )}
                  >
                    {pct >= 0 ? "+" : ""}
                    {pct.toFixed(2)}%
                  </span>
                ) : null}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                <span className="font-mono">{oldText}</span>
                {" → "}
                <span className="font-mono text-foreground">{newText}</span>
              </div>
              {change.notes ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {change.notes}
                </p>
              ) : null}
              <p className="mt-1 text-[11px] text-muted-foreground/80">
                Recorded {new Date(change.createdAt).toLocaleDateString()} by{" "}
                {change.changedByName ?? "system"}
              </p>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

function StatutoryDisplay({
  label,
  value,
  note,
  children,
}: {
  label: string
  value: string
  /// `note` is either a single string (rendered as a <p>) or a full
  /// React node (rendered as-is — used by the PCB reliefs breakdown
  /// to render a vertical list inside the note area).
  note?: React.ReactNode
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
        typeof note === "string" ? (
          <p className="text-[11px] text-muted-foreground">{note}</p>
        ) : (
          // Render React nodes (e.g. the PCB reliefs breakdown list)
          // directly so callers can wrap them in their own block-level
          // elements.
          <div className="text-[11px] text-muted-foreground">{note}</div>
        )
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
