"use client"

import { useActionState, useState } from "react"

import {
  savePayrollCompanyInfoAction,
  savePayrollSettingsAction,
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
import { ID_TYPE_LABELS, idTypes } from "@/modules/payroll/domain/models"
import {
  CP8D_FURNISH_TYPE_OPTIONS,
  EMPLOYER_CATEGORY_OPTIONS,
  EMPLOYER_STATUS_OPTIONS,
  REFERENCE_TYPE_OPTIONS,
  WORKING_DAYS_RULE_LABELS,
  workingDaysRules,
  type PayrollCompanyInfoData,
  type PayrollSettingsData,
} from "@/modules/payroll/domain/settings"

type Tab = "general" | "formE"

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
export function PayrollSettingsForm(props: {
  settings: PayrollSettingsData | null
  companyInfo: PayrollCompanyInfoData | null
}) {
  const [tab, setTab] = useState<Tab>("general")
  const generalComplete = props.settings !== null
  const formEComplete = isFormEComplete(props.companyInfo)

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
      </nav>

      {tab === "general" && <GeneralTab settings={props.settings} />}
      {tab === "formE" && <FormETab companyInfo={props.companyInfo} />}
    </div>
  )
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

function GeneralTab(props: { settings: PayrollSettingsData | null }) {
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
          <CardTitle className="text-base">Overtime multipliers</CardTitle>
          <CardDescription>
            Applied to hourly rate when computing OT pay. Defaults follow
            Malaysian Employment Act (1.5× / 2× / 3×).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <Field label="Normal day OT (×)">
            <Input
              name="otRateNormal"
              type="number"
              step="0.01"
              min="1"
              max="10"
              defaultValue={s?.otRateNormal ?? 1.5}
            />
          </Field>
          <Field label="Rest day OT (×)">
            <Input
              name="otRateRest"
              type="number"
              step="0.01"
              min="1"
              max="10"
              defaultValue={s?.otRateRest ?? 2}
            />
          </Field>
          <Field label="Public holiday OT (×)">
            <Input
              name="otRatePublicHoliday"
              type="number"
              step="0.01"
              min="1"
              max="10"
              defaultValue={s?.otRatePublicHoliday ?? 3}
            />
          </Field>
        </CardContent>
      </Card>

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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">HRDF (HRD Corp levy)</CardTitle>
          <CardDescription>
            Per PSMB Act 2001, applied to Malaysian citizens only. Set
            1.0% for Part I employers (≥10 employees) or 0.5% for
            Part II opt-in employers (5–9 employees).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Toggle
            name="hrdfEnabled"
            question="HRDF enabled?"
            defaultChecked={s?.hrdfEnabled ?? false}
          />
          <Field label="HRDF rate (%)">
            <Input
              name="hrdfRate"
              type="number"
              step="0.01"
              min="0"
              max="10"
              defaultValue={s?.hrdfRate ?? ""}
              placeholder="1"
            />
          </Field>
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
