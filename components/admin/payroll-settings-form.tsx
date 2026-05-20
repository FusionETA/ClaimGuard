"use client"

import { useActionState, useEffect, useMemo, useState } from "react"

import {
  getXeroPayrollMappingOptionsAction,
  savePayrollCompanyInfoAction,
  savePayrollSettingsAction,
  savePayrollXeroMappingAction,
  type XeroMappingOptionsActionResult,
} from "@/app/(admin)/admin/payroll/settings/actions"
import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { Button } from "@/components/ui/button"
import {
  NativeSelect,
  Toggle,
} from "@/components/admin/payroll-form-controls"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToastOnAction } from "@/components/ui/toaster"
import { cn } from "@/lib/utils"
import {
  ID_TYPE_LABELS,
  idTypes,
  type PayrollAdjustmentCategory,
} from "@/modules/payroll/domain/models"
import {
  CP8D_FURNISH_TYPE_OPTIONS,
  DEFAULT_PAYROLL_XERO_MAPPING,
  EMPLOYER_CATEGORY_OPTIONS,
  EMPLOYER_STATUS_OPTIONS,
  PAYROLL_XERO_ACCOUNT_GROUPS,
  PAYROLL_XERO_ACCOUNT_LABELS,
  PAYROLL_XERO_ALLOWANCE_CATEGORIES,
  PAYROLL_XERO_DEDUCTION_CATEGORIES,
  REFERENCE_TYPE_OPTIONS,
  WORKING_DAYS_RULE_LABELS,
  XERO_AGGREGATION_MODE_LABELS,
  getPayrollAdjustmentGroup,
  getPayrollAdjustmentLabel,
  workingDaysRules,
  xeroAggregationModes,
  xeroLineGroupingModes,
  type PayrollCompanyInfoData,
  type PayrollSettingsData,
  type PayrollXeroAccountKey,
  type XeroAggregationMode,
  type XeroLineGroupingMode,
} from "@/modules/payroll/domain/settings"

type Tab = "general" | "formE" | "xero"

const FORM_E_COMPLETION_FIELDS: Array<keyof PayrollCompanyInfoData> = [
  "employerName",
  "employerTin",
  "registrationNo",
  "referenceType",
  "referenceNo",
  "employerCategory",
  "employerStatus",
  "cp8dFurnishType",
  "addressLine1",
  "postcode",
  "city",
  "state",
  "country",
  "email",
  "declarantName",
  "declarantIdType",
  "declarantIdNumber",
  "declarantPosition",
]

/**
 * Tabbed payroll settings form. Two tabs, two independent saves:
 *   - General    → PayrollSettings  (OT, EPF defaults, working days, HRDF)
 *   - Form E     → PayrollCompanyInfo (LHDN employer particulars)
 */
export type HrdfTier = "PART_I" | "PART_II" | "NOT_APPLICABLE"

export function PayrollSettingsForm(props: {
  settings: PayrollSettingsData | null
  companyInfo: PayrollCompanyInfoData | null
  /// Number of active Malaysian-citizen employees in the org. Drives
  /// the HRDF tier (Part I vs Part II vs not-applicable) and whether
  /// the HRDF toggle is locked or editable.
  malaysianEmployeeCount: number
  hrdfTier: HrdfTier
  /// True when the org has at least one Xero connection. When false,
  /// the "sync to Xero on submit" toggles in the General tab are not
  /// rendered at all — both flags stay false in the DB.
  hasXeroConnection: boolean
}) {
  const [tab, setTab] = useState<Tab>("general")
  const generalComplete = props.settings !== null
  const formEComplete = isFormEComplete(props.companyInfo)
  const xeroComplete = isXeroMappingComplete(props.settings)

  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-3 border-y border-border/60 py-5">
        <TabPill
          active={tab === "general"}
          complete={generalComplete}
          onClick={() => setTab("general")}
        >
          General
        </TabPill>
        <TabPill
          active={tab === "formE"}
          complete={formEComplete}
          onClick={() => setTab("formE")}
        >
          Form E (LHDN)
        </TabPill>
        {props.hasXeroConnection ? (
          <TabPill
            active={tab === "xero"}
            complete={xeroComplete}
            onClick={() => setTab("xero")}
          >
            Xero sync
          </TabPill>
        ) : null}
      </nav>

      {tab === "general" && (
        <GeneralTab
          settings={props.settings}
          malaysianEmployeeCount={props.malaysianEmployeeCount}
          hrdfTier={props.hrdfTier}
          hasXeroConnection={props.hasXeroConnection}
        />
      )}
      {tab === "formE" && <FormETab companyInfo={props.companyInfo} />}
      {tab === "xero" && props.hasXeroConnection ? (
        <XeroMappingTab settings={props.settings} />
      ) : null}
    </div>
  )
}

/**
 * "Complete" for the Xero tab = aggregation mode set, tracking category
 * picked, every core + accrual account has an ID, AND the allowance /
 * deduction sections satisfy their chosen mode:
 *   - UNIFIED mode → the unified account (`accounts.allowance` or
 *     `accounts.deduction`) is set.
 *   - PER_CATEGORY → every category in the section's list has an
 *     account ID in the per-category map.
 */
function isXeroMappingComplete(settings: PayrollSettingsData | null): boolean {
  const m = settings?.xeroMapping
  if (!m) return false
  if (!m.trackingCategoryId) return false
  const requiredKeys: PayrollXeroAccountKey[] = [
    "salary",
    "epfEmployer",
    "socsoEmployer",
    "eisEmployer",
    "hrdfEmployer",
    "accrualEpf",
    "accrualSocso",
    "accrualEis",
    "accrualPcb",
    "accrualSalary",
  ]
  if (!requiredKeys.every((k) => Boolean(m.accounts[k]))) return false

  if (m.allowanceMode === "UNIFIED") {
    if (!m.accounts.allowance) return false
  } else {
    if (
      !PAYROLL_XERO_ALLOWANCE_CATEGORIES.every((c) =>
        Boolean(m.allowanceAccounts[c]),
      )
    ) {
      return false
    }
  }
  if (m.deductionMode === "UNIFIED") {
    if (!m.accounts.deduction) return false
  } else {
    if (
      !PAYROLL_XERO_DEDUCTION_CATEGORIES.every((c) =>
        Boolean(m.deductionAccounts[c]),
      )
    ) {
      return false
    }
  }
  return true
}

function hasValue(value: unknown) {
  return typeof value === "string" ? value.trim().length > 0 : value != null
}

function isFormEComplete(companyInfo: PayrollCompanyInfoData | null) {
  if (!companyInfo) return false

  return FORM_E_COMPLETION_FIELDS.every((field) => hasValue(companyInfo[field]))
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

// ─── General tab ──────────────────────────────────────────────────────────

function GeneralTab(props: {
  settings: PayrollSettingsData | null
  malaysianEmployeeCount: number
  hrdfTier: HrdfTier
  hasXeroConnection: boolean
}) {
  const [state, action, pending] = useActionState(
    savePayrollSettingsAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  const s = props.settings

  return (
    <form action={action} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Working-days rule
          </CardTitle>
          <CardDescription>
            Used to convert monthly salary → daily / hourly rate for
            proration and OT.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Days-per-month basis">
            <NativeSelect
              name="workingDaysRule"
              defaultValue={s?.workingDaysRule ?? "TWENTY_SIX"}
            >
              {workingDaysRules.map((r) => (
                <option key={r} value={r}>
                  {WORKING_DAYS_RULE_LABELS[r]}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">EPF defaults</CardTitle>
          <CardDescription>
            Fallback employee rate used when an employee&apos;s profile
            doesn&apos;t set their own. Employer rate is set by EPF Act
            452 (auto-stepped 13% ≤ RM 5,000 / 12% &gt; RM 5,000) — not
            configurable.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Employee rate (%) — default">
            <Input
              name="defaultEpfEmployeeRate"
              type="number"
              step="0.01"
              min="0"
              max="100"
              defaultValue={s?.defaultEpfEmployeeRate ?? 11}
            />
          </Field>
          {/* Hidden input preserves the existing DB column. The calc
              engine ignores this value (employer rate is statutory),
              but we keep the column for backward compatibility. */}
          <input
            type="hidden"
            name="defaultEpfEmployerRate"
            value={String(s?.defaultEpfEmployerRate ?? 13)}
          />
        </CardContent>
      </Card>

      <HrdfCard
        hrdfTier={props.hrdfTier}
        malaysianEmployeeCount={props.malaysianEmployeeCount}
        settings={s}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">PCB compliance</CardTitle>
          <CardDescription>
            Optional reliefs auto-applied in monthly PCB. Strictly
            per LHDN MTD Spec 2026 these are TP1 items (employee-
            declared) — but most payroll systems auto-apply them
            because the employer already knows the exact figures.
            Turn off to defer them to year-end Form BE.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Toggle
            name="autoApplySocsoEisRelief"
            question="Auto-apply SOCSO + EIS relief?"
            defaultChecked={s?.autoApplySocsoEisRelief ?? true}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Employer identifiers</CardTitle>
          <CardDescription>
            Used in payslip headers and statutory exports.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Employer ID number (LHDN E No.)">
            <Input
              name="employerIdNumber"
              defaultValue={s?.employerIdNumber ?? ""}
              placeholder="E 12345678901"
            />
          </Field>
          <Field label="MyCoID / SSM number">
            <Input
              name="myCoOrSsmNumber"
              defaultValue={s?.myCoOrSsmNumber ?? ""}
              placeholder="202301234567"
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Bank disbursement (Public Bank ECP)
          </CardTitle>
          <CardDescription>
            Required for the &ldquo;Public Bank ECP (Bulk Payroll)&rdquo;
            file under Payroll runs → Download files. Leave blank if
            you don&apos;t use Public Bank&apos;s bulk-payroll service.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Public Bank payor account number (10 digits)">
            <Input
              name="ecpPayorAccountNo"
              defaultValue={s?.ecpPayorAccountNo ?? ""}
              placeholder="3111111111"
              maxLength={10}
              inputMode="numeric"
              pattern="[0-9]{10}"
            />
          </Field>
        </CardContent>
      </Card>

      {props.hasXeroConnection ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Xero sync on submit</CardTitle>
            <CardDescription>
              When a payroll run is submitted, push the reimbursable
              claims attached to that run into Xero as bills awaiting
              payment, and post the payroll summary as a manual
              journal. Leave both off if you reconcile in Xero manually.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <Toggle
              name="syncClaimsToXeroOnSubmit"
              question="Sync claims to Xero (Awaiting Payment)?"
              defaultChecked={s?.syncClaimsToXeroOnSubmit ?? false}
            />
            <Toggle
              name="syncPayrollToXeroOnSubmit"
              question="Sync payroll to Xero (Manual Journal)?"
              defaultChecked={s?.syncPayrollToXeroOnSubmit ?? false}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Leave carry-forward (coming soon)
          </CardTitle>
          <CardDescription>
            Placeholders for the upcoming leave integration. Not yet
            enforced.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <Toggle
            name="leaveCarryForwardAllowed"
            question="Carry-forward allowed?"
            defaultChecked={s?.leaveCarryForwardAllowed ?? false}
          />
          <Field label="Limit (days)">
            <Input
              name="leaveCarryForwardLimitDays"
              type="number"
              min="0"
              max="365"
              defaultValue={s?.leaveCarryForwardLimitDays ?? ""}
            />
          </Field>
          <Field label="Expiry (months)">
            <Input
              name="leaveCarryForwardExpiryMonths"
              type="number"
              min="0"
              max="36"
              defaultValue={s?.leaveCarryForwardExpiryMonths ?? ""}
            />
          </Field>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save General"}
        </Button>
      </div>
    </form>
  )
}

// ─── Form E tab ───────────────────────────────────────────────────────────

function FormETab(props: { companyInfo: PayrollCompanyInfoData | null }) {
  const [state, action, pending] = useActionState(
    savePayrollCompanyInfoAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  const c = props.companyInfo

  return (
    <form action={action} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Employer particulars</CardTitle>
          <CardDescription>
            LHDN Form E filing identity. Free-text codes match the published
            LHDN values; pick from the list or type a custom value.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Employer name" className="md:col-span-2">
            <Input
              name="employerName"
              defaultValue={c?.employerName ?? ""}
            />
          </Field>
          <Field label="Employer TIN">
            <Input
              name="employerTin"
              defaultValue={c?.employerTin ?? ""}
              placeholder="C 12345678901"
            />
          </Field>
          <Field label="Registration No. (SSM / ROC)">
            <Input
              name="registrationNo"
              defaultValue={c?.registrationNo ?? ""}
              placeholder="202301234567"
            />
          </Field>
          <Field label="Reference type">
            <NativeSelect
              name="referenceType"
              defaultValue={c?.referenceType ?? ""}
            >
              <option value="">-</option>
              {REFERENCE_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Reference No.">
            <Input
              name="referenceNo"
              defaultValue={c?.referenceNo ?? ""}
            />
          </Field>
          <Field label="Employer category">
            <NativeSelect
              name="employerCategory"
              defaultValue={c?.employerCategory ?? ""}
            >
              <option value="">-</option>
              {EMPLOYER_CATEGORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Employer status">
            <NativeSelect
              name="employerStatus"
              defaultValue={c?.employerStatus ?? ""}
            >
              <option value="">-</option>
              {EMPLOYER_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="CP8D furnish type" className="md:col-span-2">
            <NativeSelect
              name="cp8dFurnishType"
              defaultValue={c?.cp8dFurnishType ?? ""}
            >
              <option value="">-</option>
              {CP8D_FURNISH_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Correspondence address</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Address line 1" className="md:col-span-2">
            <Input
              name="addressLine1"
              defaultValue={c?.addressLine1 ?? ""}
            />
          </Field>
          <Field label="Address line 2" className="md:col-span-2">
            <Input
              name="addressLine2"
              defaultValue={c?.addressLine2 ?? ""}
            />
          </Field>
          <Field label="Postcode">
            <Input
              name="postcode"
              defaultValue={c?.postcode ?? ""}
            />
          </Field>
          <Field label="City">
            <Input
              name="city"
              defaultValue={c?.city ?? ""}
            />
          </Field>
          <Field label="State">
            <Input
              name="state"
              defaultValue={c?.state ?? ""}
            />
          </Field>
          <Field label="Country">
            <Input
              name="country"
              defaultValue={c?.country ?? "Malaysia"}
            />
          </Field>
          <Field label="Phone">
            <Input
              name="phone"
              defaultValue={c?.phone ?? ""}
            />
          </Field>
          <Field label="Handphone">
            <Input
              name="handphone"
              defaultValue={c?.handphone ?? ""}
            />
          </Field>
          <Field label="Email" className="md:col-span-2">
            <Input
              name="email"
              type="email"
              defaultValue={c?.email ?? ""}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tax agent</CardTitle>
          <CardDescription>
            Optional. Populated if a licensed tax agent files Form E on
            your behalf.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Agent name" className="md:col-span-2">
            <Input
              name="taxAgentName"
              defaultValue={c?.taxAgentName ?? ""}
            />
          </Field>
          <Field label="Agent TIN">
            <Input
              name="taxAgentTin"
              defaultValue={c?.taxAgentTin ?? ""}
            />
          </Field>
          <Field label="Agent licence No.">
            <Input
              name="taxAgentLicenceNo"
              defaultValue={c?.taxAgentLicenceNo ?? ""}
            />
          </Field>
          <Field label="Agent phone">
            <Input
              name="taxAgentPhone"
              defaultValue={c?.taxAgentPhone ?? ""}
            />
          </Field>
          <Field label="Agent email">
            <Input
              name="taxAgentEmail"
              type="email"
              defaultValue={c?.taxAgentEmail ?? ""}
            />
          </Field>
          <Field label="Firm name" className="md:col-span-2">
            <Input
              name="taxAgentFirmName"
              defaultValue={c?.taxAgentFirmName ?? ""}
            />
          </Field>
          <Field label="Firm address line 1" className="md:col-span-2">
            <Input
              name="taxAgentFirmAddressLine1"
              defaultValue={c?.taxAgentFirmAddressLine1 ?? ""}
            />
          </Field>
          <Field label="Firm address line 2" className="md:col-span-2">
            <Input
              name="taxAgentFirmAddressLine2"
              defaultValue={c?.taxAgentFirmAddressLine2 ?? ""}
            />
          </Field>
          <Field label="Firm postcode">
            <Input
              name="taxAgentFirmPostcode"
              defaultValue={c?.taxAgentFirmPostcode ?? ""}
            />
          </Field>
          <Field label="Firm city">
            <Input
              name="taxAgentFirmCity"
              defaultValue={c?.taxAgentFirmCity ?? ""}
            />
          </Field>
          <Field label="Firm state" className="md:col-span-2">
            <Input
              name="taxAgentFirmState"
              defaultValue={c?.taxAgentFirmState ?? ""}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Declarant</CardTitle>
          <CardDescription>
            The individual signing off Form E (usually a director or HR
            head).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Declarant name" className="md:col-span-2">
            <Input
              name="declarantName"
              defaultValue={c?.declarantName ?? ""}
            />
          </Field>
          <Field label="ID type">
            <NativeSelect
              name="declarantIdType"
              defaultValue={c?.declarantIdType ?? ""}
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
              name="declarantIdNumber"
              defaultValue={c?.declarantIdNumber ?? ""}
            />
          </Field>
          <Field label="Position" className="md:col-span-2">
            <Input
              name="declarantPosition"
              defaultValue={c?.declarantPosition ?? ""}
              placeholder="Director / Head of HR"
            />
          </Field>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save Form E"}
        </Button>
      </div>
    </form>
  )
}

// ─── HRDF card with auto-detected tier (Part I / Part II / N/A) ─────────

/**
 * Renders the HRDF settings card with behaviour that follows the
 * PSMB Act 2001 First Schedule (as amended 2021):
 *
 *   - PART_I (≥10 Malaysian employees): MANDATORY. Toggle is LOCKED
 *     ON, rate is LOCKED at 1.0%. Hidden inputs force the values on
 *     save so the admin can't accidentally turn it off.
 *
 *   - PART_II (5-9 Malaysian employees): OPTIONAL. Admin chooses
 *     whether to opt in. Rate defaults to 0.5% when enabled.
 *
 *   - NOT_APPLICABLE (<5 Malaysian employees): the levy doesn't
 *     apply. Toggle is LOCKED OFF.
 *
 * The Malaysian-citizen employee count is computed server-side
 * (PSMB Act § 2 defines "employee" = citizen of Malaysia, so PRs and
 * foreign workers don't count toward the threshold).
 */
function HrdfCard(props: {
  hrdfTier: HrdfTier
  malaysianEmployeeCount: number
  settings: PayrollSettingsData | null
}) {
  if (props.hrdfTier === "PART_I") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">HRDF (HRD Corp levy)</CardTitle>
          <CardDescription>
            <span className="font-medium text-foreground">
              Part I — mandatory (1.0%).
            </span>{" "}
            Detected {props.malaysianEmployeeCount} active
            Malaysian-citizen employees. Per PSMB Act 2001, employers
            with 10 or more employees must register and pay the levy.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <LockedDisplay
            label="HRDF enabled?"
            value="Yes (mandatory)"
            note="Cannot be disabled while you have ≥10 Malaysian employees."
          />
          <LockedDisplay
            label="HRDF rate (%)"
            value="1.0"
            note="Statutory rate for Part I employers."
          />
          <input type="hidden" name="hrdfEnabled" value="true" />
          <input type="hidden" name="hrdfRate" value="1" />
        </CardContent>
      </Card>
    )
  }

  if (props.hrdfTier === "PART_II") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">HRDF (HRD Corp levy)</CardTitle>
          <CardDescription>
            <span className="font-medium text-foreground">
              Part II — optional (0.5%).
            </span>{" "}
            Detected {props.malaysianEmployeeCount} active
            Malaysian-citizen employees. Registration is voluntary; opt
            in to pay the levy.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Toggle
            name="hrdfEnabled"
            question="HRDF enabled?"
            defaultChecked={props.settings?.hrdfEnabled ?? false}
          />
          <Field label="HRDF rate (%)">
            <Input
              name="hrdfRate"
              type="number"
              step="0.01"
              min="0"
              max="10"
              defaultValue={props.settings?.hrdfRate ?? ""}
              placeholder="0.5"
            />
          </Field>
        </CardContent>
      </Card>
    )
  }

  // NOT_APPLICABLE
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">HRDF (HRD Corp levy)</CardTitle>
        <CardDescription>
          <span className="font-medium text-foreground">Not applicable.</span>{" "}
          Detected {props.malaysianEmployeeCount} active
          Malaysian-citizen{" "}
          {props.malaysianEmployeeCount === 1 ? "employee" : "employees"}.
          HRDF applies once you have at least 5 employees (Part II opt-in)
          or 10 employees (Part I mandatory).
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <LockedDisplay
          label="HRDF enabled?"
          value="No (below threshold)"
          note="Will switch on automatically when you reach 5 Malaysian employees."
        />
        <input type="hidden" name="hrdfEnabled" value="false" />
        <input type="hidden" name="hrdfRate" value="0" />
      </CardContent>
    </Card>
  )
}

function LockedDisplay({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note?: string
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">
        {label}
        <span className="ml-1.5 inline-block rounded-sm border border-border/70 bg-muted px-1.5 py-px align-middle text-[9px] font-semibold uppercase tracking-wide leading-none text-muted-foreground">
          Auto
        </span>
      </Label>
      <div className="flex h-12 w-full items-center rounded-2xl border border-border/80 bg-muted/40 px-4 py-2 text-base text-foreground shadow-sm sm:text-sm">
        {value}
      </div>
      {note ? (
        <p className="text-[11px] text-muted-foreground">{note}</p>
      ) : null}
    </div>
  )
}

// ─── Tiny field + form helpers (mirror payroll-employee-detail.tsx) ──────

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

// ─── Xero mapping tab ────────────────────────────────────────────────────

/**
 * Xero sync mapping form. Fetches COA + tracking category options
 * from the active Xero connection on mount, then renders:
 *   - an aggregation toggle (per-employee vs sum-by-project)
 *   - a tracking-category picker (single)
 *   - per-category COA dropdowns grouped as Expense / Accrual / Extras
 *
 * Form values come from `settings.xeroMapping` (or `DEFAULT_*` when
 * unset). Saves via `savePayrollXeroMappingAction`.
 */
function XeroMappingTab({
  settings,
}: {
  settings: PayrollSettingsData | null
}) {
  const current = settings?.xeroMapping ?? DEFAULT_PAYROLL_XERO_MAPPING

  const [state, action, pending] = useActionState(
    savePayrollXeroMappingAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  // Controlled state — start from the persisted mapping. We don't
  // need every keystroke to be controlled, but the aggregation +
  // tracking category drive other UX (e.g. clearing the team picker
  // when project changes) so they're easier as React state.
  const [aggregationMode, setAggregationMode] = useState<XeroAggregationMode>(
    current.aggregationMode,
  )
  const [trackingCategoryId, setTrackingCategoryId] = useState<string>(
    current.trackingCategoryId ?? "",
  )
  const [accounts, setAccounts] = useState<
    Partial<Record<PayrollXeroAccountKey, string>>
  >(() => {
    const seed: Partial<Record<PayrollXeroAccountKey, string>> = {}
    for (const [key, id] of Object.entries(current.accounts)) {
      if (id) seed[key as PayrollXeroAccountKey] = id
    }
    return seed
  })

  // Allowance + Deduction mode toggles and per-category account maps.
  // Both maps are kept ALWAYS — flipping the toggle doesn't clear the
  // other mode's data so admins can experiment freely.
  const [allowanceMode, setAllowanceMode] = useState<XeroLineGroupingMode>(
    current.allowanceMode,
  )
  const [allowanceAccounts, setAllowanceAccounts] = useState<
    Record<string, string>
  >(() => {
    const seed: Record<string, string> = {}
    for (const [k, v] of Object.entries(current.allowanceAccounts)) {
      if (v) seed[k] = v
    }
    return seed
  })
  const [deductionMode, setDeductionMode] = useState<XeroLineGroupingMode>(
    current.deductionMode,
  )
  const [deductionAccounts, setDeductionAccounts] = useState<
    Record<string, string>
  >(() => {
    const seed: Record<string, string> = {}
    for (const [k, v] of Object.entries(current.deductionAccounts)) {
      if (v) seed[k] = v
    }
    return seed
  })

  // Fetch dropdown options in the background. The form renders
  // immediately with empty option lists; once the action returns,
  // the dropdowns get populated. This avoids a "Loading Xero options"
  // spinner blocking the UI — admins see the structure right away.
  const [accountOptions, setAccountOptions] = useState<
    Array<{ id: string; code: string; name: string; type?: string }>
  >([])
  const [trackingCategories, setTrackingCategories] = useState<
    Array<{
      id: string
      name: string
      options: Array<{ id: string; name: string }>
    }>
  >([])
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const [hasNoConnection, setHasNoConnection] = useState(false)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await getXeroPayrollMappingOptionsAction()
      if (cancelled) return
      if (result.status === "success") {
        setAccountOptions(result.options.accounts)
        setTrackingCategories(result.options.trackingCategories)
      } else if (result.status === "empty") {
        setHasNoConnection(true)
      } else {
        setOptionsError(result.message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (hasNoConnection) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Xero sync</CardTitle>
          <CardDescription>
            Connect Xero to map payroll categories to your chart of accounts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No active Xero connection found. Connect Xero from{" "}
            <span className="font-medium">Settings → Integrations</span> first.
          </p>
        </CardContent>
      </Card>
    )
  }
  const accrualAccountKeys = new Set<PayrollXeroAccountKey>([
    "accrualEpf",
    "accrualSocso",
    "accrualEis",
    "accrualPcb",
    "accrualSalary",
  ])
  const accountOptionsFor = (key: PayrollXeroAccountKey) => {
    const liabilityTypes = new Set(["LIABILITY", "CURRLIAB", "TERMLIAB"])
    return accountOptions.filter((acc) =>
      accrualAccountKeys.has(key)
        ? Boolean(acc.type && liabilityTypes.has(acc.type))
        : acc.type === "EXPENSE",
    )
  }

  return (
    <form action={action} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Aggregation</CardTitle>
          <CardDescription>
            How expense lines roll up on the manual journal we post to Xero.
            Accruals are always summed regardless of this setting.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Expense line aggregation">
            <NativeSelect
              name="aggregationMode"
              value={aggregationMode}
              onChange={(e) =>
                setAggregationMode(e.target.value as XeroAggregationMode)
              }
            >
              {xeroAggregationModes.map((mode) => {
                // Only "Sum by project" is live today. Per-employee
                // aggregation is on the roadmap but not yet exposed —
                // lock the picker to sum-by-project and flag the
                // per-employee option as upcoming so it can't be selected.
                const upcoming = mode !== "SUM_BY_PROJECT"
                return (
                  <option key={mode} value={mode} disabled={upcoming}>
                    {XERO_AGGREGATION_MODE_LABELS[mode]}
                    {upcoming ? " (upcoming feature)" : ""}
                  </option>
                )
              })}
            </NativeSelect>
          </Field>
          <Field label="Tracking category (for project)">
            <NativeSelect
              name="trackingCategoryId"
              value={trackingCategoryId}
              onChange={(e) => setTrackingCategoryId(e.target.value)}
            >
              <option value="">— None —</option>
              {trackingCategories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name} ({cat.options.length} options)
                </option>
              ))}
            </NativeSelect>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Each bill / journal line will be stamped with the project name as
              the value for this tracking category.
            </p>
          </Field>
        </CardContent>
      </Card>

      {PAYROLL_XERO_ACCOUNT_GROUPS.map((group) => (
        <Card key={group.title}>
          <CardHeader>
            <CardTitle>{group.title}</CardTitle>
            <CardDescription>{group.description}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {group.keys.map((key) => (
              <Field key={key} label={PAYROLL_XERO_ACCOUNT_LABELS[key]}>
                {(() => {
                  const scopedAccountOptions = accountOptionsFor(key)
                  return (
                <NativeSelect
                  name={`account.${key}`}
                  value={accounts[key] ?? ""}
                  onChange={(e) =>
                    setAccounts((prev) => ({
                      ...prev,
                      [key]: e.target.value || undefined,
                    }))
                  }
                >
                  <option value="">— Not set —</option>
                  {scopedAccountOptions.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.code} — {acc.name}
                    </option>
                  ))}
                </NativeSelect>
                  )
                })()}
              </Field>
            ))}
          </CardContent>
        </Card>
      ))}

      {/* Allowance card */}
      <LineGroupCard
        title="Allowances"
        description="Where allowance, bonus, OT and other non-salary earnings post to. Pick one account for everything, or map each category to its own COA for a tidier P&L."
        mode={allowanceMode}
        onModeChange={setAllowanceMode}
        modeFieldName="allowanceMode"
        unifiedAccountKey="allowance"
        unifiedAccountValue={accounts.allowance ?? ""}
        unifiedAccountFieldName="account.allowance"
        unifiedAccountPlaceholder="Account every allowance posts to"
        onUnifiedAccountChange={(value) =>
          setAccounts((prev) => ({
            ...prev,
            allowance: value || undefined,
          }))
        }
        perCategoryFieldPrefix="allowanceAccount"
        categories={PAYROLL_XERO_ALLOWANCE_CATEGORIES}
        perCategoryValues={allowanceAccounts}
        onPerCategoryChange={(cat, value) =>
          setAllowanceAccounts((prev) => {
            const next = { ...prev }
            if (value) next[cat] = value
            else delete next[cat]
            return next
          })
        }
        accountOptions={accountOptions.filter((a) => a.type === "EXPENSE")}
      />

      {/* Deduction card */}
      <LineGroupCard
        title="Deductions"
        description="Admin-entered deductions only (unpaid leave, salary adjustments, advance recovery). Statutory deductions like PCB, Zakat and CP38 post via their existing accrual accounts."
        mode={deductionMode}
        onModeChange={setDeductionMode}
        modeFieldName="deductionMode"
        unifiedAccountKey="deduction"
        unifiedAccountValue={accounts.deduction ?? ""}
        unifiedAccountFieldName="account.deduction"
        unifiedAccountPlaceholder="Account every deduction posts to"
        onUnifiedAccountChange={(value) =>
          setAccounts((prev) => ({
            ...prev,
            deduction: value || undefined,
          }))
        }
        perCategoryFieldPrefix="deductionAccount"
        categories={PAYROLL_XERO_DEDUCTION_CATEGORIES}
        perCategoryValues={deductionAccounts}
        onPerCategoryChange={(cat, value) =>
          setDeductionAccounts((prev) => {
            const next = { ...prev }
            if (value) next[cat] = value
            else delete next[cat]
            return next
          })
        }
        accountOptions={accountOptions.filter((a) => a.type === "EXPENSE")}
      />

      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save Xero mapping"}
        </Button>
      </div>
    </form>
  )
}

// ─── Allowance / Deduction line-group card ───────────────────────────────

/**
 * Reusable card for the Allowance and Deduction sections. Shows a
 * mode toggle and either a single COA picker (UNIFIED) or a per-
 * category table (PER_CATEGORY). The state for both modes is
 * preserved so admins can flip back and forth without losing data.
 */
function LineGroupCard(props: {
  title: string
  description: string
  mode: XeroLineGroupingMode
  onModeChange: (mode: XeroLineGroupingMode) => void
  modeFieldName: string
  unifiedAccountKey: string
  unifiedAccountValue: string
  unifiedAccountFieldName: string
  unifiedAccountPlaceholder: string
  onUnifiedAccountChange: (value: string) => void
  perCategoryFieldPrefix: string
  categories: PayrollAdjustmentCategory[]
  perCategoryValues: Record<string, string>
  onPerCategoryChange: (cat: PayrollAdjustmentCategory, value: string) => void
  accountOptions: Array<{ id: string; code: string; name: string }>
}) {
  // Group the categories by their `group` label so the table shows
  // sensible section headers (Allowances / Recurring Monthly,
  // Remuneration, Benefits-in-kind / Perquisites, Deductions).
  const groupedCategories = useMemo(() => {
    const buckets = new Map<string, PayrollAdjustmentCategory[]>()
    for (const cat of props.categories) {
      const group = getPayrollAdjustmentGroup(cat) || "Other"
      const list = buckets.get(group) ?? []
      list.push(cat)
      buckets.set(group, list)
    }
    return Array.from(buckets.entries())
  }, [props.categories])

  return (
    <Card>
      <CardHeader>
        {/* No flex-wrap — keep the toggle pinned top-right even on
            long descriptions. `min-w-0 flex-1` lets the title block
            shrink so the toggle never gets pushed onto a new line. */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <CardTitle>{props.title}</CardTitle>
            <CardDescription>{props.description}</CardDescription>
          </div>
          <div
            role="radiogroup"
            aria-label={`${props.title} mapping mode`}
            className="grid shrink-0 grid-cols-2 gap-1 rounded-xl border border-border/60 bg-muted/30 p-1 text-xs"
          >
            <input
              type="hidden"
              name={props.modeFieldName}
              value={props.mode}
            />
            {xeroLineGroupingModes.map((m) => {
              const active = m === props.mode
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => props.onModeChange(m)}
                  className={cn(
                    "rounded-lg px-3 py-1 transition-colors",
                    active
                      ? "bg-background font-medium text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m === "UNIFIED" ? "One account" : "Per category"}
                </button>
              )
            })}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {props.mode === "UNIFIED" ? (
          <Field label={`${props.title} account`}>
            <NativeSelect
              name={props.unifiedAccountFieldName}
              value={props.unifiedAccountValue}
              onChange={(e) => props.onUnifiedAccountChange(e.target.value)}
            >
              <option value="">— {props.unifiedAccountPlaceholder} —</option>
              {props.accountOptions.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.code} — {acc.name}
                </option>
              ))}
            </NativeSelect>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Every {props.title.toLowerCase()} line on the manual journal
              will post to this account.
            </p>
          </Field>
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Pick a Chart of Account for each category. The sync refuses to
              post a payroll run if any category present on a payslip is left
              unmapped, so the admin sees exactly what's missing before approval.
            </p>
            {groupedCategories.map(([group, cats]) => (
              <div
                key={group}
                className="overflow-hidden rounded-xl border border-border/60"
              >
                <div className="bg-muted/40 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {group}
                </div>
                <table className="w-full text-sm">
                  <tbody>
                    {cats.map((cat) => (
                      <tr key={cat} className="border-t border-border/40">
                        <td className="w-1/2 px-3 py-2 align-middle">
                          <span className="font-medium text-foreground">
                            {getPayrollAdjustmentLabel(cat)}
                          </span>
                          <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                            {cat}
                          </span>
                        </td>
                        <td className="px-3 py-2 align-middle">
                          <NativeSelect
                            name={`${props.perCategoryFieldPrefix}.${cat}`}
                            value={props.perCategoryValues[cat] ?? ""}
                            onChange={(e) =>
                              props.onPerCategoryChange(cat, e.target.value)
                            }
                          >
                            <option value="">— Not set —</option>
                            {props.accountOptions.map((acc) => (
                              <option key={acc.id} value={acc.id}>
                                {acc.code} — {acc.name}
                              </option>
                            ))}
                          </NativeSelect>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
