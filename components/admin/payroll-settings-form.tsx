"use client"

import { useActionState, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Copy, ExternalLink, Eye, EyeOff, Trash2 } from "lucide-react"

import {
  deletePortalCredentialAction,
  getXeroPayrollMappingOptionsAction,
  savePayrollCompanyInfoAction,
  savePayrollSettingsAction,
  savePayrollXeroMappingAction,
  savePortalCredentialAction,
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
import { MALAYSIAN_BANKS } from "@/modules/payroll/domain/malaysian-banks"
import { Label } from "@/components/ui/label"
import { useToast, useToastOnAction } from "@/components/ui/toaster"
import { cn } from "@/lib/utils"
import type { PortalCredentialDto } from "@/modules/payroll/application/services/portal-credential.service"
import {
  ID_TYPE_LABELS,
  idTypes,
  type PayrollAdjustmentCategory,
} from "@/modules/payroll/domain/models"
import { SKBBK_PHASE_SCHEDULE } from "@/modules/payroll/domain/statutory-tables"
import {
  CP8D_FURNISH_TYPE_OPTIONS,
  DEFAULT_PAYROLL_XERO_MAPPING,
  EMPLOYER_CATEGORY_OPTIONS,
  EMPLOYER_STATUS_OPTIONS,
  isCompanyInfoReadyForPayroll,
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

type Tab = "general" | "formE" | "credentials" | "xero"

/**
 * Tabbed payroll settings form. Four tabs, independent saves:
 *   - General     → PayrollSettings  (OT, EPF defaults, working days, HRDF)
 *   - Form E      → PayrollCompanyInfo (LHDN employer particulars)
 *   - Credentials → PayrollPortalCredential (saved KWSP + PERKESO logins)
 *   - Xero sync   → PayrollSettings.xeroMapping (shown only when Xero is connected)
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
  /// Saved KWSP / PERKESO portal credentials. Empty array when the
  /// admin hasn't saved anything yet. Plaintext password is included —
  /// see service comments for the threat model.
  portalCredentials: PortalCredentialDto[]
}) {
  const [tab, setTab] = useState<Tab>("general")
  const generalComplete = props.settings !== null
  // Mirror the FormE inputs in state so the tab-pill highlight + the
  // inline red helpers clear AS THE ADMIN TYPES, not only after they
  // save. Inputs stay uncontrolled (no cursor jumping) — this state is
  // just a derived mirror for the visual indicators.
  const [liveCompanyInfo, setLiveCompanyInfo] = useState<PayrollCompanyInfoData | null>(
    props.companyInfo,
  )
  // Resync when the server re-renders with fresh values (e.g. after a
  // successful save) so the indicator can't drift from persisted data.
  useEffect(() => {
    setLiveCompanyInfo(props.companyInfo)
  }, [props.companyInfo])
  // Single source of truth — same helper the payroll-readiness service
  // uses to decide whether to BLOCK a payroll-run submit. So "tab red"
  // <-> "payroll submit blocked" can never disagree.
  const formEComplete = isCompanyInfoReadyForPayroll(liveCompanyInfo)
  const xeroComplete = isXeroMappingComplete(props.settings)
  // "Complete" for the Credentials tab = at least one portal has a
  // saved password. The tab is purely a convenience feature so we use
  // a soft definition; admins who don't want to save credentials
  // simply leave the dot showing.
  // Credentials tab is purely a convenience feature (lets admins copy
  // saved portal logins) — no downstream report depends on it, so we
  // treat it as OPTIONAL: no red warning state. Subtitle just reports
  // how many of the two portals (KWSP, PERKESO) have credentials
  // saved, or "Optional" when none.
  const credentialsSavedCount = props.portalCredentials.filter(
    (c) => c.hasPassword,
  ).length
  const credentialsComplete = credentialsSavedCount > 0
  const credentialsSubtitle =
    credentialsSavedCount > 0 ? `${credentialsSavedCount} saved` : undefined

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
        <TabPill
          active={tab === "credentials"}
          complete={credentialsComplete}
          optional
          optionalSubtitle={credentialsSubtitle}
          onClick={() => setTab("credentials")}
        >
          Credentials
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
          companyInfo={liveCompanyInfo}
        />
      )}
      {tab === "formE" && (
        <FormETab
          companyInfo={liveCompanyInfo}
          onFieldChange={(field, value) =>
            setLiveCompanyInfo((prev) =>
              ({
                ...(prev ?? ({} as PayrollCompanyInfoData)),
                [field]: value,
              } as PayrollCompanyInfoData),
            )
          }
        />
      )}
      {tab === "credentials" && (
        <CredentialsTab credentials={props.portalCredentials} />
      )}
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

function isBlank(value: string | null | undefined): boolean {
  return !value || value.trim().length === 0
}

function TabPill({
  active,
  complete,
  optional = false,
  optionalSubtitle,
  onClick,
  children,
}: {
  active: boolean
  complete: boolean
  /// When true the tab is informational/convenience only — never shows
  /// the red ring or "Required fields missing" subtitle, even when
  /// `complete=false`. Used for tabs like Credentials where the data
  /// is purely admin-convenience and not required for any downstream
  /// statutory document generation.
  optional?: boolean
  /// Subtitle override for optional tabs. When `complete=true` the
  /// tab shows "Saved" (or this override if passed); when
  /// `complete=false` it shows "Optional".
  optionalSubtitle?: string
  onClick: () => void
  children: React.ReactNode
}) {
  // When the tab still has required fields blank, ring the pill in red
  // and show a tiny red dot — so the admin sees at a glance which tab
  // is blocking statutory document generation. Clears when every
  // required field in that tab is filled. Optional tabs skip the red
  // treatment entirely (see `optional` prop above).
  const showRequiredWarning = !complete && !optional
  let subtitle: string
  if (optional) {
    subtitle = complete ? (optionalSubtitle ?? "Saved") : "Optional"
  } else {
    subtitle = complete ? "Completed" : "Required fields missing"
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative min-w-36 rounded-full border px-6 py-2.5 text-left transition",
        active
          ? "border-primary bg-primary text-primary-foreground shadow-sm"
          : "border-border/70 bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
        showRequiredWarning && !active && "border-destructive/60 ring-1 ring-destructive/30",
        showRequiredWarning && active && "ring-2 ring-destructive/50",
      )}
    >
      {showRequiredWarning ? (
        <span
          aria-hidden
          className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-destructive"
        />
      ) : null}
      <span className="block text-sm font-semibold leading-tight">{children}</span>
      <span
        className={cn(
          "mt-0.5 block text-[11px] font-medium leading-tight",
          showRequiredWarning
            ? "text-destructive"
            : active
              ? "text-primary-foreground/75"
              : "text-muted-foreground",
        )}
      >
        {subtitle}
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
  /// PayrollCompanyInfo — used by the EPF + HRDF cards to read/write
  /// the two statutory employer numbers (epfEmployerNo,
  /// hrdfEmployerNo) that logically live on PayrollCompanyInfo but
  /// are surfaced on the General tab for discoverability.
  companyInfo: PayrollCompanyInfoData | null
}) {
  const [state, action, pending] = useActionState(
    savePayrollSettingsAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  const s = props.settings
  const liveCompanyInfo = props.companyInfo

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
            Both rates are set by EPF Act 452 (Third Schedule) — locked.
            Employee 11% (statutory minimum, Part A). Employer auto-
            stepped 13% ≤ RM 5,000 / 12% &gt; RM 5,000. Above-statutory
            employee contributions are captured per-employee on their
            profile under &ldquo;Employee voluntary&rdquo;.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <LockedDisplay
            label="Employee rate (%)"
            value="11"
            note="Statutory minimum per EPF Act 452 (Third Schedule, Part A)."
          />
          <Field label="EPF Employer No. (KWSP)">
            <Input
              name="epfEmployerNo"
              defaultValue={liveCompanyInfo?.epfEmployerNo ?? ""}
              placeholder="e.g. 12345678"
              maxLength={40}
            />
          </Field>
          {/* Hidden inputs keep both columns flowing to the save
              action. The calc engine ignores both at runtime
              (statutory-locked) — we keep the DB columns for
              backward compatibility with older payroll snapshots. */}
          <input
            type="hidden"
            name="defaultEpfEmployeeRate"
            value="11"
          />
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
        companyInfo={liveCompanyInfo}
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

      {/* SKBBK / Skim LINDUNG 24 Jam — read-only display.
          Rates are statutory (PERKESO publishes the gazette table per
          rollout phase); admin can't edit. Source of truth lives in
          SKBBK_PHASE_SCHEDULE in domain/statutory-tables.ts. */}
      <SkbbkInfoCard />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Payroll disbursement bank
          </CardTitle>
          <CardDescription>
            The company&apos;s bank used to pay salaries. When it&apos;s
            Public Bank, the run download offers the Public Bank ECP file;
            any other bank gets a general disbursement CSV.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Bank">
            <NativeSelect
              name="payrollBankName"
              defaultValue={s?.payrollBankName ?? ""}
            >
              <option value="">— Select bank —</option>
              {MALAYSIAN_BANKS.map((b) => (
                <option key={b.bic} value={b.name}>
                  {b.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Account number">
            <Input
              name="ecpPayorAccountNo"
              defaultValue={s?.ecpPayorAccountNo ?? ""}
              placeholder="Company payroll account no."
              maxLength={20}
              inputMode="numeric"
            />
          </Field>
          <Field label="Account holder name">
            <Input
              name="payorAccountHolderName"
              defaultValue={s?.payorAccountHolderName ?? ""}
              placeholder="As registered with the bank"
            />
          </Field>
          <Field label="Organisation code (optional)">
            <Input
              name="payorOrganisationCode"
              defaultValue={s?.payorOrganisationCode ?? ""}
              placeholder="Some banks require this"
            />
          </Field>
        </CardContent>
      </Card>

      {props.hasXeroConnection ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Xero sync on submit</CardTitle>
            <CardDescription>
              When a payroll run is submitted, post the payroll summary
              as a manual journal. Attached reimbursements are included
              in that journal using each claim&apos;s selected expense
              account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <input type="hidden" name="syncClaimsToXeroOnSubmit" value="false" />
            <Toggle
              name="syncPayrollToXeroOnSubmit"
              question="Sync payroll to Xero (Manual Journal)?"
              defaultChecked={s?.syncPayrollToXeroOnSubmit ?? false}
            />
          </CardContent>
        </Card>
      ) : null}

      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save General"}
        </Button>
      </div>
    </form>
  )
}

// ─── Form E tab ───────────────────────────────────────────────────────────

function FormETab(props: {
  companyInfo: PayrollCompanyInfoData | null
  /// Called on every input/select change so the parent can mirror form
  /// values in state and update the tab-pill highlight + inline reds
  /// LIVE as the admin types (instead of waiting for a save).
  onFieldChange?: (
    field: keyof PayrollCompanyInfoData,
    value: string,
  ) => void
}) {
  const [state, action, pending] = useActionState(
    savePayrollCompanyInfoAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  const c = props.companyInfo

  // Single delegated change handler — fires on every input/select event
  // inside the form. Tells the parent which field changed so it can
  // update its mirrored state and refresh the tab-pill colour + inline
  // reds immediately (no need to save first).
  function handleChange(event: React.ChangeEvent<HTMLFormElement>) {
    // At runtime `event.target` is the actual changed input, not the
    // form itself — TS just types it as the form. Cast via `unknown`.
    const target = event.target as unknown as
      | HTMLInputElement
      | HTMLSelectElement
      | HTMLTextAreaElement
      | null
    if (!target || !target.name) return
    props.onFieldChange?.(
      target.name as keyof PayrollCompanyInfoData,
      target.value,
    )
  }

  return (
    <form action={action} className="space-y-6" onChange={handleChange}>
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
              aria-invalid={isBlank(c?.employerName) || undefined}
            />
            {isBlank(c?.employerName) ? (
              <p className="mt-1 text-xs font-medium text-destructive">
                Required — appears on every statutory document.
              </p>
            ) : null}
          </Field>
          <Field label="Employer No. (LHDN E No.)">
            <Input
              name="employerTin"
              defaultValue={c?.employerTin ?? ""}
              placeholder="E 1234567890"
              aria-invalid={isBlank(c?.employerTin) || undefined}
            />
            {isBlank(c?.employerTin) ? (
              <p className="mt-1 text-xs font-medium text-destructive">
                Required for PCB TXT, EPF CSV, CP8D, and EA.
              </p>
            ) : null}
          </Field>
          <Field label="Registration No. (SSM / ROC)">
            <Input
              name="registrationNo"
              defaultValue={c?.registrationNo ?? ""}
              placeholder="202301234567"
              aria-invalid={isBlank(c?.registrationNo) || undefined}
            />
            {isBlank(c?.registrationNo) ? (
              <p className="mt-1 text-xs font-medium text-destructive">
                Required for SOCSO+EIS upload and CP8D.
              </p>
            ) : null}
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
          <Field label="PERKESO Employer Code">
            <Input
              name="perkesoEmployerCode"
              defaultValue={c?.perkesoEmployerCode ?? ""}
              placeholder="SOCSO/EIS employer code"
              aria-invalid={isBlank(c?.perkesoEmployerCode) || undefined}
            />
            {isBlank(c?.perkesoEmployerCode) ? (
              <p className="mt-1 text-xs font-medium text-destructive">
                Required for the SOCSO+EIS upload.
              </p>
            ) : null}
          </Field>
          <Field label="Zakat No. (optional)">
            <Input
              name="zakatNumber"
              defaultValue={c?.zakatNumber ?? ""}
              placeholder="Zakat employer / registration number"
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

// ─── Credentials tab ─────────────────────────────────────────────────────

const PORTAL_DEFINITIONS = [
  {
    portal: "KWSP" as const,
    label: "KWSP (EPF)",
    url: "https://secure.kwsp.gov.my/employer/employer/login?0",
    description:
      "Employer i-Akaun login — used for EPF Borang A monthly submission and i-Saraan deposits.",
    fields: [
      { key: "userId", label: "User ID", placeholder: "MYKWSP123" },
      // password rendered separately
      { key: "image", label: "Image", placeholder: "elephant" },
      { key: "secretCode", label: "Secret code", placeholder: "ABC123" },
    ],
  },
  {
    portal: "PERKESO" as const,
    label: "PERKESO (SOCSO/EIS)",
    url: "https://assist.perkeso.gov.my/ms/employer/login",
    description:
      "ASSIST Employer Portal login — used for SOCSO + EIS monthly contribution upload.",
    fields: [
      { key: "userId", label: "User ID", placeholder: "MYCOMPANY01" },
      { key: "securityPhrase", label: "Security phrase", placeholder: "My phrase" },
      { key: "passwordReminder", label: "Password reminder", placeholder: "Hint" },
    ],
  },
] as const

function CredentialsTab(props: { credentials: PortalCredentialDto[] }) {
  // Index by portal name for O(1) lookup of saved values.
  const byPortal = useMemo(() => {
    const map = new Map<string, PortalCredentialDto>()
    for (const c of props.credentials) map.set(c.portal, c)
    return map
  }, [props.credentials])

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Saved portal credentials</CardTitle>
          <CardDescription>
            Save your statutory portal logins so anyone in the finance
            team can copy + paste them into the upload portal without
            digging through a password manager. Passwords are encrypted
            at rest (AES-256-GCM, keyed off the deploy&apos;s{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
              PORTAL_CREDS_KEY
            </code>
            ). One credential set per portal per org.
          </CardDescription>
        </CardHeader>
      </Card>

      {PORTAL_DEFINITIONS.map((def) => (
        <PortalCard
          key={def.portal}
          definition={def}
          existing={byPortal.get(def.portal) ?? null}
        />
      ))}
    </div>
  )
}

function PortalCard(props: {
  definition: (typeof PORTAL_DEFINITIONS)[number]
  existing: PortalCredentialDto | null
}) {
  const { toast } = useToast()
  const router = useRouter()
  const [state, action, pending] = useActionState(
    savePortalCredentialAction,
    initialSettingsActionState,
  )
  const [deleteState, deleteAction, deletePending] = useActionState(
    deletePortalCredentialAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)
  useToastOnAction(deleteState)

  // Track the props value so the soft refresh from `router.refresh()`
  // re-syncs our local `record` state with the server's fresh DTO.
  // (Without this resync, a save would clear `passwordChanged` but
  // keep the stale `hasPassword=false` until a manual reload.)
  const [record, setRecord] = useState<PortalCredentialDto | null>(props.existing)
  useEffect(() => {
    setRecord(props.existing)
  }, [props.existing])

  // Mark the password "dirty" only when the admin actually edits it.
  // We never repopulate the password field on mount (it would mean
  // displaying the plaintext in the DOM by default); admins can hit
  // "Reveal" to see what's saved.
  const [passwordValue, setPasswordValue] = useState("")
  const [passwordChanged, setPasswordChanged] = useState(false)
  const [passwordVisible, setPasswordVisible] = useState(false)

  // After a successful save / delete, ask Next to re-run the page's
  // server component. That re-fetches the credential row and flows the
  // fresh DTO back through `props.existing` → the resync effect above.
  // No full page reload, no scroll-jump, no flash of the other tabs.
  useEffect(() => {
    if (state.status === "success") {
      setPasswordValue("")
      setPasswordChanged(false)
      setPasswordVisible(false)
      router.refresh()
    }
  }, [state, router])
  useEffect(() => {
    if (deleteState.status === "success") {
      setPasswordValue("")
      setPasswordChanged(false)
      setPasswordVisible(false)
      router.refresh()
    }
  }, [deleteState, router])

  async function copy(value: string | null, label: string) {
    if (!value) {
      toast({ title: `${label} is empty.`, variant: "error" })
      return
    }
    try {
      await navigator.clipboard.writeText(value)
      toast({ title: `${label} copied.`, variant: "success" })
    } catch {
      toast({
        title: `Could not access clipboard. Long-press the field to copy.`,
        variant: "error",
      })
    }
  }

  function valueOf(key: string): string | null {
    if (!record) return null
    switch (key) {
      case "userId":
        return record.userId
      case "image":
        return record.image
      case "secretCode":
        return record.secretCode
      case "securityPhrase":
        return record.securityPhrase
      case "passwordReminder":
        return record.passwordReminder
      default:
        return null
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">{props.definition.label}</CardTitle>
          <CardDescription>{props.definition.description}</CardDescription>
        </div>
        <Button
          asChild
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5"
        >
          <a
            href={props.definition.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open portal
          </a>
        </Button>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          <input type="hidden" name="portal" value={props.definition.portal} />
          <input
            type="hidden"
            name="passwordChanged"
            value={String(passwordChanged)}
          />

          <div className="grid gap-4 md:grid-cols-2">
            {props.definition.fields.map((f) => (
              <CredentialField
                key={f.key}
                name={f.key}
                label={f.label}
                placeholder={f.placeholder}
                defaultValue={valueOf(f.key) ?? ""}
                onCopy={() => copy(valueOf(f.key), f.label)}
              />
            ))}

            {/* Password — special row with reveal + copy.
                NEVER pre-fill the actual password into the DOM. Admin
                hits "Reveal" to display it. */}
            <div className="space-y-1.5 md:col-span-2">
              <Label className="text-xs">
                Password
                {record?.hasPassword ? (
                  <span className="ml-1.5 inline-block rounded-sm border border-emerald-500/50 bg-emerald-500/10 px-1.5 py-px align-middle text-[9px] font-semibold uppercase tracking-wide leading-none text-emerald-700 dark:text-emerald-300">
                    Saved
                  </span>
                ) : null}
              </Label>
              <div className="flex items-stretch gap-2">
                <div className="relative flex-1">
                  <Input
                    name="password"
                    type={passwordVisible ? "text" : "password"}
                    value={
                      passwordChanged
                        ? passwordValue
                        : passwordVisible
                          ? record?.password ?? ""
                          : ""
                    }
                    placeholder={
                      record?.hasPassword
                        ? "(saved — leave blank to keep)"
                        : "Type the portal password"
                    }
                    onChange={(e) => {
                      setPasswordValue(e.target.value)
                      setPasswordChanged(true)
                    }}
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setPasswordVisible((v) => !v)}
                  disabled={!record?.hasPassword && !passwordChanged}
                  aria-label={passwordVisible ? "Hide password" : "Reveal password"}
                >
                  {passwordVisible ? (
                    <>
                      <EyeOff className="h-3.5 w-3.5" /> Hide
                    </>
                  ) : (
                    <>
                      <Eye className="h-3.5 w-3.5" /> Reveal
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    const v = passwordChanged ? passwordValue : record?.password
                    void copy(v ?? null, "Password")
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </Button>
              </div>
              {!passwordChanged && record?.hasPassword ? (
                <p className="text-[11px] text-muted-foreground">
                  Leave blank to keep the existing password. Type to
                  replace it.
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <Label className="text-xs">Notes</Label>
              <Input
                name="notes"
                defaultValue={record?.notes ?? ""}
                placeholder="Anything you want to remember (e.g. PIC, last rotation date)"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <p className="text-[11px] text-muted-foreground">
              {record?.updatedAt
                ? `Last updated ${new Date(record.updatedAt).toLocaleString()}`
                : "No credentials saved yet."}
            </p>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save credentials"}
            </Button>
          </div>
        </form>

        {/* Delete sits in its own form so we don't nest a <form> inside
            the save <form> above (which the React DOM hydrator rejects
            with "<form> cannot be a descendant of <form>"). Rendered
            only when there's an existing record to clear. */}
        {record ? (
          <form action={deleteAction} className="mt-3 flex justify-end">
            <input
              type="hidden"
              name="portal"
              value={props.definition.portal}
            />
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={deletePending}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {deletePending ? "Deleting…" : "Delete saved credentials"}
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  )
}

function CredentialField(props: {
  name: string
  label: string
  defaultValue: string
  placeholder?: string
  onCopy: () => void
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{props.label}</Label>
      <div className="flex items-stretch gap-2">
        <Input
          name={props.name}
          defaultValue={props.defaultValue}
          placeholder={props.placeholder}
          className="flex-1"
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={props.onCopy}
          aria-label={`Copy ${props.label}`}
        >
          <Copy className="h-3.5 w-3.5" />
          Copy
        </Button>
      </div>
    </div>
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
  companyInfo: PayrollCompanyInfoData | null
}) {
  const employerNoField = (
    <Field label="HRDF Employer No.">
      <Input
        name="hrdfEmployerNo"
        defaultValue={props.companyInfo?.hrdfEmployerNo ?? ""}
        placeholder={
          props.hrdfTier === "NOT_APPLICABLE"
            ? "Only needed if registered with HRD Corp"
            : "e.g. 1234567890"
        }
        maxLength={40}
      />
    </Field>
  )
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
            Malaysian-citizen employees. Once headcount exceeds 10, HRDF
            is auto-enabled at 1.0%. If someone is archived and the
            count drops back to 10 or below, HRDF returns to the
            optional zone (5-10 employees) where you can decide.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <LockedDisplay
            label="HRDF enabled?"
            value="Yes (mandatory)"
            note="Cannot be disabled while you have more than 10 Malaysian employees."
          />
          <LockedDisplay
            label="HRDF rate (%)"
            value="1.0"
            note="Statutory rate for Part I employers."
          />
          {employerNoField}
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
            Malaysian-citizen employees (decide zone: 5-10). Registration
            is voluntary — opt in to pay the levy, or leave off. Once
            headcount exceeds 10, HRDF auto-enables at 1.0%.
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
          {employerNoField}
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
          HRDF applies once you have at least 5 employees (Part II
          opt-in, decide zone 5-10) or more than 10 employees (Part I
          auto-enabled, mandatory 1.0%).
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <LockedDisplay
          label="HRDF enabled?"
          value="No (below threshold)"
          note="Will switch on automatically when you reach 5 Malaysian employees."
        />
        {employerNoField}
        <input type="hidden" name="hrdfEnabled" value="false" />
        <input type="hidden" name="hrdfRate" value="0" />
      </CardContent>
    </Card>
  )
}

/**
 * Read-only card showing the org's current SKBBK (Skim LINDUNG 24 Jam)
 * subscription. Rates aren't admin-editable — PERKESO sets them and
 * the gazette table lives in domain/statutory-tables.ts. The card
 * exists so admins can SEE which phase is active without grepping
 * source code, and so the next phase ("TBD") is visible when PERKESO
 * eventually announces phase 2 / 3 dates.
 */
function SkbbkInfoCard() {
  // SKBBK_PHASE_SCHEDULE is ordered chronologically (oldest first) so
  // the LAST entry is the most recent / currently active phase. When
  // future phases land, they get prepended in the source array and
  // this card auto-picks up the new top entry.
  const phases = [...SKBBK_PHASE_SCHEDULE]
  const current = phases[phases.length - 1] ?? null
  const next = null // No phase 2 / 3 dates known yet

  const monthLabels = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ] as const

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          SKBBK — Skim LINDUNG 24 Jam
        </CardTitle>
        <CardDescription>
          PERKESO&apos;s Non-Employment Injury Security Scheme. Employee-
          only, capped at RM 6,000/month wage. <strong>Opt-in per
          employee</strong> — flip the toggle on each employee&apos;s
          statutory tab (Manage Employee → Statutory → SKBBK card) to
          include them. Rate is set by PERKESO and rolls out in phases —
          admin can&apos;t change it here.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        {current ? (
          <>
            <LockedDisplay
              label="Current phase"
              value={`${current.employeeRatePct}% (employee share)`}
              note={`Effective ${monthLabels[current.startMonth - 1]} ${current.startYear} onwards.`}
            />
            <LockedDisplay
              label="Salary cap"
              value="RM 6,000 / month"
              note="Same ceiling as the existing SOCSO Act 4 cap."
            />
            <LockedDisplay
              label="Employer share"
              value="0% (none)"
              note="SKBBK is fully borne by the employee — distinct from SOCSO + EIS where both sides contribute."
            />
            <LockedDisplay
              label="Enrolment"
              value="Opt-in per employee"
              note="Default OFF. Admin enables per employee on the statutory tab. Snapshot is frozen when the payroll run is submitted — re-editing a submitted run for an unrelated reason won't unwind an already-remitted SKBBK contribution."
            />
            <LockedDisplay
              label="Next phase"
              value={
                next
                  ? `${(next as { employeeRatePct: number }).employeeRatePct}% from ${monthLabels[(next as { startMonth: number }).startMonth - 1]} ${(next as { startYear: number }).startYear}`
                  : "TBD"
              }
              note="PERKESO will announce the date and rate for phase 2 (1.0%) and phase 3 (1.25%). Calc engine picks them up automatically once the gazette tables ship."
            />
          </>
        ) : (
          <LockedDisplay
            label="Status"
            value="Not yet active"
            note="No SKBBK phase recorded for this period. Pre-Jun-2026 runs compute SKBBK as 0."
          />
        )}
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
    "accrualSkbbk",
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
        highlightedOverrideCategories={["wages_overtime", "wages_leave_pay"]}
      />

      {/* Deduction card */}
      <LineGroupCard
        title="Deductions"
        description="Admin-entered deductions only (salary adjustments, advance recovery). Statutory deductions like PCB, Zakat and CP38 post via their existing accrual accounts. Unpaid leave is netted directly against the salary expense — no separate COA mapping needed."
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
  /** Categories shown unfolded by default in the UNIFIED-mode
   *  "Optional per-category overrides" section (e.g. OT and
   *  unutilized leave pay). Others sit behind a "Show all" toggle. */
  highlightedOverrideCategories?: PayrollAdjustmentCategory[]
}) {
  const highlighted = useMemo(
    () => new Set(props.highlightedOverrideCategories ?? []),
    [props.highlightedOverrideCategories],
  )
  const [showAllOverrides, setShowAllOverrides] = useState(false)
  const overrideCategories = useMemo(() => {
    if (showAllOverrides || highlighted.size === 0) return props.categories
    return props.categories.filter((c) => highlighted.has(c))
  }, [props.categories, showAllOverrides, highlighted])
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
          <div className="space-y-4">
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
                will post to this account, except for any per-category
                override picked below.
              </p>
            </Field>

            {/* Optional per-category overrides. A row left blank uses the
                unified account; a row with an account picked overrides
                just that category — handy when admins want OT or
                unutilized leave pay on its own COA without flipping the
                whole card to per-category mode. */}
            <details className="rounded-xl border border-border/60 bg-muted/20 [&[open]>summary>span:last-child]:rotate-180">
              <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-xs font-medium text-foreground">
                <span>Optional per-category overrides</span>
                <span className="transition-transform">▾</span>
              </summary>
              <div className="space-y-2 border-t border-border/60 px-3 py-3">
                <table className="w-full text-sm">
                  <tbody>
                    {overrideCategories.map((cat) => (
                      <tr key={cat} className="border-t border-border/40 first:border-t-0">
                        <td className="w-1/2 px-1 py-2 align-middle">
                          <span className="font-medium text-foreground">
                            {getPayrollAdjustmentLabel(cat)}
                          </span>
                          <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                            {cat}
                          </span>
                        </td>
                        <td className="px-1 py-2 align-middle">
                          <NativeSelect
                            name={`${props.perCategoryFieldPrefix}.${cat}`}
                            value={props.perCategoryValues[cat] ?? ""}
                            onChange={(e) =>
                              props.onPerCategoryChange(cat, e.target.value)
                            }
                          >
                            <option value="">— Use unified account —</option>
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
                {highlighted.size > 0 && highlighted.size < props.categories.length ? (
                  <button
                    type="button"
                    onClick={() => setShowAllOverrides((v) => !v)}
                    className="text-[11px] font-medium text-primary hover:underline"
                  >
                    {showAllOverrides
                      ? "Show fewer"
                      : `Show all overrides (${props.categories.length})`}
                  </button>
                ) : null}
              </div>
            </details>
          </div>
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
