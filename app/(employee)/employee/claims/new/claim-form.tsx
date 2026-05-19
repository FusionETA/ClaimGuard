"use client"

import { useActionState, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertCircle, Camera, LoaderCircle, Upload } from "lucide-react"

import { submitClaimAction } from "@/app/(employee)/employee/claims/new/actions"
import { initialClaimFormState } from "@/app/(employee)/employee/claims/new/form-state"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { computeMileageAmount } from "@/lib/mileage"
import { cn } from "@/lib/utils"
import type {
  ChartAccountWithRemainingLimit,
  ClaimRunPreview,
} from "@/modules/claims/domain/models"
import type { ChartOfAccountOption } from "@/modules/organization/domain/models"

/**
 * Pre-fill values produced by the OCR + AI step (`ClaimFlow`). The form
 * uses these as initial values, but the user can still edit any field.
 * Sticky values from a failed submit (carried in `state.values`) always
 * win over these so the user's last typed value isn't replaced by a
 * stale AI suggestion.
 */
export type ClaimFormAiPrefill = {
  title?: string
  amount?: string
  spentAt?: string
  description?: string
  currency?: string
  chartOfAccountId?: string
}

export function ClaimForm({
  chartAccounts,
  mileageAccounts,
  bankAccounts,
  defaultMileageRate,
  mileageUnit,
  claimRunPreview,
  organizationName,
  employeeProjects = [],
  allowedCurrencies = [],
  defaultCurrency,
  onSuccess,
  compact = false,
  defaultClaimType,
  aiPrefill,
  prefilledReceiptFile,
  onBack,
}: {
  chartAccounts: ChartAccountWithRemainingLimit[]
  mileageAccounts: ChartAccountWithRemainingLimit[]
  bankAccounts: ChartOfAccountOption[]
  defaultMileageRate?: number
  mileageUnit: "KM" | "MILE"
  claimRunPreview?: ClaimRunPreview
  organizationName?: string
  /// Projects the employee is assigned to. The picker is required when the
  /// list is non-empty; if it's empty (legacy / unassigned employee) the
  /// project field is hidden.
  employeeProjects?: Array<{ id: string; name: string }>
  /// ISO 4217 codes the org admin has enabled. When non-empty, drives a
  /// currency dropdown shown next to the amount field. Empty list keeps
  /// the legacy single-currency behaviour (currency field hidden).
  allowedCurrencies?: string[]
  /// Default currency to pre-select when AI hasn't detected one.
  defaultCurrency?: string
  onSuccess?: () => void
  compact?: boolean
  /// When set (by ClaimFlow), forces the initial claim-type radio. The
  /// in-form type-picker still appears so the user can flip mid-edit.
  defaultClaimType?: "EXPENSE" | "MILEAGE"
  /// AI-extracted defaults from the OCR step. Sticky form values still
  /// win on a re-submit; AI is only used on first render.
  aiPrefill?: ClaimFormAiPrefill
  /// Receipt file already chosen in the wizard's OCR step. The form
  /// populates its hidden file input from this on mount so the user
  /// doesn't have to re-pick. They can still tap the upload zone to
  /// replace it.
  prefilledReceiptFile?: File | null
  /// Optional back-button shown in the form header. Used by ClaimFlow
  /// to let the user return to the receipt-upload step.
  onBack?: () => void
}) {
  const [state, formAction, pending] = useActionState(
    submitClaimAction,
    initialClaimFormState
  )
  const [selectedReceiptName, setSelectedReceiptName] = useState(
    prefilledReceiptFile?.name ?? "",
  )
  const receiptInputRef = useRef<HTMLInputElement | null>(null)

  const reattachPrefilledReceipt = useCallback(() => {
    if (!prefilledReceiptFile) return
    const input = receiptInputRef.current
    if (!input) return
    try {
      const dt = new DataTransfer()
      dt.items.add(prefilledReceiptFile)
      input.files = dt.files
      setSelectedReceiptName(prefilledReceiptFile.name)
    } catch {
      // DataTransfer not available (very old browser). Fall back to
      // showing the filename and letting the user re-tap to upload.
    }
  }, [prefilledReceiptFile])

  // Carry the receipt File chosen in the OCR step into the form's hidden
  // file input. The DataTransfer dance is the supported way to set
  // `input.files` programmatically in modern browsers (Chrome 73+,
  // Safari 14.1+, Firefox 62+) — needed so the submit FormData carries
  // the file the user already picked, instead of forcing them to re-pick.
  useEffect(() => {
    reattachPrefilledReceipt()
  }, [reattachPrefilledReceipt])

  useEffect(() => {
    if (state.status === "error") {
      reattachPrefilledReceipt()
    }
    // Depend on the state reference so back-to-back validation errors
    // still re-fire (so the receipt gets re-attached after every
    // failed submit, not just the first one). See useToastOnAction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, reattachPrefilledReceipt])

  const [claimType, setClaimType] = useState<"EXPENSE" | "MILEAGE">(
    state.status === "error"
      ? state.values.claimType
      : defaultClaimType ?? state.values?.claimType ?? "EXPENSE"
  )
  // String defaults across this form fall back through:
  //   sticky value (after a failed submit) → AI prefill (first render) → ""
  // We use `||` rather than `??` because `state.values.foo` is initialized to
  // "" (not undefined), so `??` would never reach the AI prefill on first
  // render. `||` correctly treats empty strings as "no sticky value yet".
  const [selectedChartAccountId, setSelectedChartAccountId] = useState(
    state?.values?.chartOfAccountId || aiPrefill?.chartOfAccountId || ""
  )
  const [currency, setCurrency] = useState<string>(() => {
    // Preserve sticky value on resubmit; otherwise prefer AI-detected, then
    // org default, then first allowed code, then fallback "MYR".
    if (state.values.currency) return state.values.currency
    if (aiPrefill?.currency) return aiPrefill.currency
    if (defaultCurrency) return defaultCurrency
    if (allowedCurrencies.length > 0) return allowedCurrencies[0]!
    return "MYR"
  })
  const [paymentType, setPaymentType] = useState<"PERSONAL" | "COMPANY">(
    state?.values?.paymentType ?? "PERSONAL"
  )
  const [payViaAccountId, setPayViaAccountId] = useState(
    state?.values?.payViaAccountId ?? ""
  )
  const [projectId, setProjectId] = useState(
    state?.values?.projectId ?? (employeeProjects.length === 1 ? employeeProjects[0]!.id : ""),
  )
  const [distance, setDistance] = useState(state?.values?.distance ?? "")
  // Track amount as state so we can run live limit validation while the user
  // types — a controlled input lets us re-compute `liveAmount` per keystroke.
  const [amountInput, setAmountInput] = useState(
    state?.values?.amount || aiPrefill?.amount || ""
  )
  const [descriptionInput, setDescriptionInput] = useState(
    state?.values?.description || aiPrefill?.description || ""
  )
  /// Optional "spending with" input — client / vendor / internal team
  /// the money was spent on. Sticky after a failed submit via the
  /// server-returned values.
  const [spendingWithInput, setSpendingWithInput] = useState(
    state?.values?.spendingWith ?? "",
  )
  /// Supporting documents the user picks. Controlled list since the
  /// browser's native multi-file input is awkward when the user wants
  /// to add files in two separate clicks. We keep our own list and
  /// rebuild a hidden file input's FileList on submit via DataTransfer.
  const [supportingFiles, setSupportingFiles] = useState<File[]>([])
  const supportingInputRef = useRef<HTMLInputElement | null>(null)

  // Keep the hidden file input's FileList in sync with our state so
  // the form action sends every file under `supportingFile`.
  useEffect(() => {
    const input = supportingInputRef.current
    if (!input) return
    const dt = new DataTransfer()
    for (const f of supportingFiles) dt.items.add(f)
    input.files = dt.files
  }, [supportingFiles])

  useEffect(() => {
    if (state?.values?.chartOfAccountId) {
      setSelectedChartAccountId(state.values.chartOfAccountId)
    }
  }, [state?.values?.chartOfAccountId])

  useEffect(() => {
    if (state.status === "success") {
      setSelectedReceiptName("")
      setSelectedChartAccountId("")
      setPaymentType("PERSONAL")
      setPayViaAccountId("")
      setClaimType("EXPENSE")
      setDistance("")
      setAmountInput("")
      setDescriptionInput("")
      setSpendingWithInput("")
      setSupportingFiles([])
      setCurrency(defaultCurrency ?? allowedCurrencies[0] ?? "MYR")
      onSuccess?.()
    }
    // Depend on the state reference so back-to-back successes still
    // re-fire (e.g. user submits, succeeds, immediately submits again).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, onSuccess, defaultCurrency, allowedCurrencies])

  // Re-sync amount with the server-returned sticky value after a failed submit
  // so the form preserves the user's last typed value. Truthy check (not
  // `!== undefined`) so the initial-state empty-string doesn't overwrite the
  // AI prefill on first mount — same reasoning as the chartOfAccountId /
  // payViaAccountId effects below.
  useEffect(() => {
    if (state.values?.amount) {
      setAmountInput(state.values.amount)
    }
  }, [state.values?.amount])

  useEffect(() => {
    if (state?.values?.payViaAccountId) {
      setPayViaAccountId(state.values.payViaAccountId)
    }
  }, [state?.values?.payViaAccountId])

  useEffect(() => {
    if (state.status === "error") {
      setClaimType(state.values.claimType)
      setDescriptionInput(state.values.description)
    }
  }, [state])

  useEffect(() => {
    if (paymentType !== "COMPANY") {
      setPayViaAccountId("")
    }
  }, [paymentType])

  // When switching claim type, the available account list changes — drop the
  // current selection so the user picks one that's valid for the new type.
  useEffect(() => {
    setSelectedChartAccountId("")
  }, [claimType])

  const visibleAccounts =
    claimType === "MILEAGE" ? mileageAccounts : chartAccounts

  const selectedChartAccount = useMemo(
    () => visibleAccounts.find((account) => account.id === selectedChartAccountId),
    [visibleAccounts, selectedChartAccountId]
  )

  // Resolved mileage rate — per-account override else org default.
  const resolvedMileageRate =
    selectedChartAccount?.mileageRate ?? defaultMileageRate ?? 0
  const distanceNumber = Number(distance)
  const computedMileageAmount =
    claimType === "MILEAGE" &&
    Number.isFinite(distanceNumber) &&
    distanceNumber > 0 &&
    resolvedMileageRate > 0
      ? computeMileageAmount({ distance: distanceNumber, rate: resolvedMileageRate })
      : 0

  const canSubmit =
    visibleAccounts.length > 0 &&
    (claimType === "EXPENSE" || resolvedMileageRate > 0) &&
    (paymentType !== "COMPANY" || (bankAccounts.length > 0 && payViaAccountId.length > 0))

  // True when the wizard handed us prefill data but the AI couldn't extract
  // anything meaningful (empty title/amount/date all at once). Useful so we
  // show a friendly "fill manually" hint instead of leaving the user to
  // wonder whether the scan worked.
  const aiPrefillEmpty =
    aiPrefill !== undefined &&
    !aiPrefill.title &&
    !aiPrefill.amount &&
    !aiPrefill.spentAt &&
    !aiPrefill.description
  const aiPrefillFilledSomething =
    aiPrefill !== undefined &&
    Boolean(
      aiPrefill.title ||
        aiPrefill.amount ||
        aiPrefill.spentAt ||
        aiPrefill.description ||
        aiPrefill.chartOfAccountId,
    )

  // Compute the amount the user is *trying* to claim (typed amount for
  // expense, computed mileage amount otherwise) and check it against the
  // selected account's remaining limit. We use this to show a live warning
  // before submit so the user isn't surprised by a server error.
  const liveAmount =
    claimType === "MILEAGE" ? computedMileageAmount : Number(amountInput)
  const remaining = selectedChartAccount?.remainingLimit
  const overLimit =
    remaining != null &&
    Number.isFinite(liveAmount) &&
    liveAmount > 0 &&
    liveAmount > remaining.remaining

  /** Inline error text + alert icon for any single field. */
  const FieldError = ({ message }: { message?: string }) =>
    message ? (
      <p className="mt-1 flex items-start gap-1.5 text-sm font-semibold text-destructive">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{message}</span>
      </p>
    ) : null

  // Collect all current field errors so we can render one banner at the top
  // of the form. Over-limit is no longer an error — the claim can still
  // submit, just gets flagged for admin attention. The inline warning
  // (rendered below) handles that case.
  const allErrors = [
    state.errors?.title,
    state.errors?.chartOfAccountId,
    state.errors?.amount,
    state.errors?.distance,
    state.errors?.mileageOriginAddress,
    state.errors?.mileageDestinationAddress,
    state.errors?.spentAt,
    state.errors?.description,
    state.errors?.receiptUrl,
    state.errors?.payViaAccountId,
  ].filter((message): message is string => Boolean(message))

  // Shared field blocks used in both layouts
  const mainFields = (
    <>
      {aiPrefillFilledSomething ? (
        <div className="flex items-start gap-2 rounded-2xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm leading-6 text-foreground">
          <span className="mt-0.5 text-primary">✨</span>
          <span>
            <span className="font-bold">AI filled in what it could read.</span>{" "}
            Review the values, then add the project, account, and pay-with options below.
          </span>
        </div>
      ) : null}

      {aiPrefillEmpty ? (
        <div className="flex items-start gap-2 rounded-2xl border border-amber-300/60 bg-amber-50/70 px-4 py-3 text-sm leading-6 text-amber-900">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            The receipt scan didn&rsquo;t pick up enough text to pre-fill anything. Type the
            details manually below — the receipt photo is still attached.
          </span>
        </div>
      ) : null}

      {/* Claim-type toggle — drives which account list is shown and which
          fields are required. */}
      <div className="space-y-2">
        <Label>Claim type</Label>
        <input type="hidden" name="claimType" value={claimType} />
        <div
          role="radiogroup"
          aria-label="Claim type"
          className="grid grid-cols-2 gap-2 rounded-2xl border border-border/70 bg-card/94 p-1 shadow-ambient"
        >
          {(
            [
              { value: "EXPENSE" as const, label: "Expense claim" },
              { value: "MILEAGE" as const, label: "Mileage claim"},
            ]
          ).map((option) => {
            const active = claimType === option.value
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setClaimType(option.value)}
                className={cn(
                  "flex flex-col items-start rounded-xl px-4 py-3 text-left text-sm font-semibold transition-colors",
                  active
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-surface-low hover:text-foreground"
                )}
              >
                <span>{option.label}</span>
                <span
                  className={cn(
                    "text-[11px] font-medium",
                    active ? "text-primary-foreground/80" : "text-muted-foreground"
                  )}
                >
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="title">Claim title</Label>
        <Input
          id="title"
          name="title"
          placeholder={
            claimType === "MILEAGE"
              ? "Client visit, project site travel..."
              : "Conference flight, client dinner, ride-share, office hardware..."
          }
          defaultValue={state.values?.title || aiPrefill?.title || ""}
          aria-invalid={Boolean(state.errors?.title)}
        />
        <FieldError message={state.errors?.title} />
      </div>

      {employeeProjects.length > 0 ? (
        <div className="space-y-2">
          <Label htmlFor="projectId">Project</Label>
          <input type="hidden" name="projectId" value={projectId} />
          <Select value={projectId || undefined} onValueChange={setProjectId}>
            <SelectTrigger
              id="projectId"
              aria-invalid={Boolean(state.errors?.projectId)}
            >
              <SelectValue placeholder="Select project" />
            </SelectTrigger>
            <SelectContent>
              {employeeProjects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError message={state.errors?.projectId} />
          <p className="text-xs text-muted-foreground">
            Routing follows your team in this project.
          </p>
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="chartOfAccountId">
          {claimType === "MILEAGE" ? "Mileage account" : "Chart of account"}
        </Label>
        {visibleAccounts.length === 0 ? (
          <div className="rounded-[20px] border border-amber-300/50 bg-amber-50/70 p-4 text-sm leading-6 text-amber-900 sm:rounded-[24px]">
            {claimType === "MILEAGE"
              ? "No accounts have been enabled for mileage claims yet. Ask your admin to enable one in Settings → Mileage claims."
              : organizationName
                ? `No selectable chart of account has been enabled for ${organizationName} yet. Ask your admin to connect Xero and enable claim accounts in Settings.`
                : "No selectable chart of account has been enabled yet. Ask your admin to connect Xero and enable claim accounts in Settings."}
          </div>
        ) : (
          <div className="space-y-3">
            <Select
              name="chartOfAccountId"
              value={selectedChartAccountId}
              onValueChange={setSelectedChartAccountId}
            >
              <SelectTrigger id="chartOfAccountId" aria-invalid={Boolean(state.errors?.chartOfAccountId)}>
                <SelectValue placeholder={claimType === "MILEAGE" ? "Select mileage account" : "Select chart of account"} />
              </SelectTrigger>
              <SelectContent>
                {visibleAccounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.code} · {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {selectedChartAccount ? (
              <div className="rounded-[20px] border border-border/70 bg-card/94 p-4 text-sm text-muted-foreground shadow-ambient backdrop-blur-sm sm:rounded-[24px]">
                <p className="font-bold text-foreground">
                  {selectedChartAccount.code} · {selectedChartAccount.name}
                </p>
                <p className="mt-1 leading-6">
                  {selectedChartAccount.type
                    ? `${selectedChartAccount.type}${selectedChartAccount.status ? ` · ${selectedChartAccount.status}` : ""}`
                    : selectedChartAccount.status ?? "Enabled for claim submission"}
                </p>
                {selectedChartAccount.remainingLimit ? (
                  <p className="mt-2 text-xs font-semibold text-foreground">
                    {selectedChartAccount.remainingLimit.used.toFixed(2)} of{" "}
                    {selectedChartAccount.remainingLimit.limit.toFixed(2)} used —{" "}
                    {selectedChartAccount.remainingLimit.remaining.toFixed(2)} remaining
                    {selectedChartAccount.remainingLimit.period === "MONTHLY"
                      ? " this month"
                      : selectedChartAccount.remainingLimit.period === "YEARLY"
                        ? " this year"
                        : " per claim"}
                    {selectedChartAccount.remainingLimit.scope === "ORG_WIDE"
                      ? " (org-wide)"
                      : ""}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
        <FieldError message={state.errors?.chartOfAccountId} />
      </div>

      {claimType === "MILEAGE" ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="distance">Distance ({mileageUnit === "MILE" ? "miles" : "km"})</Label>
              <Input
                id="distance"
                name="distance"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={distance}
                onChange={(event) => setDistance(event.target.value)}
                aria-invalid={Boolean(state.errors?.distance)}
              />
              <FieldError message={state.errors?.distance} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="spentAt">Trip date</Label>
              <Input
                id="spentAt"
                name="spentAt"
                type="date"
                defaultValue={state.values?.spentAt ?? ""}
                className="min-w-0 max-w-full appearance-none pr-3"
                aria-invalid={Boolean(state.errors?.spentAt)}
              />
              <FieldError message={state.errors?.spentAt} />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="mileageOriginAddress">From</Label>
              <Input
                id="mileageOriginAddress"
                name="mileageOriginAddress"
                placeholder="Origin"
                defaultValue={state.values?.mileageOriginAddress ?? ""}
                aria-invalid={Boolean(state.errors?.mileageOriginAddress)}
              />
              <FieldError message={state.errors?.mileageOriginAddress} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="mileageDestinationAddress">To</Label>
              <Input
                id="mileageDestinationAddress"
                name="mileageDestinationAddress"
                placeholder="Destination"
                defaultValue={state.values?.mileageDestinationAddress ?? ""}
                aria-invalid={Boolean(state.errors?.mileageDestinationAddress)}
              />
              <FieldError message={state.errors?.mileageDestinationAddress} />
            </div>
          </div>

          {resolvedMileageRate > 0 ? (
            <div className="rounded-[20px] border border-border/70 bg-card/94 p-4 text-sm leading-6 text-muted-foreground shadow-ambient backdrop-blur-sm sm:rounded-[24px]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">
                Calculated amount
              </p>
              <p className="mt-2 font-semibold text-foreground">
                {distanceNumber > 0
                  ? `${distanceNumber.toFixed(2)} ${mileageUnit === "MILE" ? "miles" : "km"} × ${resolvedMileageRate} = ${computedMileageAmount.toFixed(2)}`
                  : `Rate: ${resolvedMileageRate} per ${mileageUnit === "MILE" ? "mile" : "km"}`}
              </p>
            </div>
          ) : (
            <div className="rounded-[20px] border border-amber-300/50 bg-amber-50/70 p-4 text-sm leading-6 text-amber-900 sm:rounded-[24px]">
              No mileage rate configured. Ask your admin to set a rate in Settings → Mileage claims.
            </div>
          )}
        </>
      ) : (
        <div className="space-y-2">
          <div
            className={cn(
              "grid gap-4",
              allowedCurrencies.length > 0
                ? "sm:grid-cols-[1.4fr_0.8fr_1fr]"
                : "sm:grid-cols-2",
            )}
          >
            <div className="space-y-2">
              <Label htmlFor="amount">Amount</Label>
              <Input
                id="amount"
                name="amount"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={amountInput}
                onChange={(event) => setAmountInput(event.target.value)}
                aria-invalid={Boolean(state.errors?.amount) || overLimit}
              />
              <FieldError message={state.errors?.amount} />
            </div>

            {allowedCurrencies.length > 0 ? (
              <div className="space-y-2">
                <Label htmlFor="currency">Currency</Label>
                <input type="hidden" name="currency" value={currency} />
                <Select value={currency} onValueChange={setCurrency}>
                  <SelectTrigger id="currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {allowedCurrencies.map((code) => (
                      <SelectItem key={code} value={code}>
                        {code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="spentAt">Expense date</Label>
              <Input
                id="spentAt"
                name="spentAt"
                type="date"
                defaultValue={state.values?.spentAt || aiPrefill?.spentAt || ""}
                className="min-w-0 max-w-full appearance-none pr-3"
                aria-invalid={Boolean(state.errors?.spentAt)}
              />
              <FieldError message={state.errors?.spentAt} />
            </div>
          </div>

          {/* Live over-limit warning. Submission is still allowed; the
              claim gets flagged for admin attention. Styled amber rather
              than destructive so the user understands they CAN submit. */}
          {overLimit && remaining ? (
            <div className="flex items-start gap-2 rounded-2xl border border-amber-300/60 bg-amber-50/70 px-4 py-3 text-sm leading-6 text-amber-900">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                <span className="font-bold">
                  Over the limit by {(liveAmount - remaining.remaining).toFixed(2)}.
                </span>{" "}
                {selectedChartAccount?.name} has {remaining.remaining.toFixed(2)} remaining
                {remaining.period === "MONTHLY"
                  ? " this month"
                  : remaining.period === "YEARLY"
                    ? " this year"
                    : " per claim"}
                . You can still submit — the claim will be flagged for the admin to review.
              </span>
            </div>
          ) : null}
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="spendingWith">
          Spending with{" "}
          <span className="text-xs font-normal text-muted-foreground">
            — optional
          </span>
        </Label>
        <Input
          id="spendingWith"
          name="spendingWith"
          placeholder="e.g. ABC Client Sdn Bhd, TechMart Supplies, Internal team lunch"
          value={spendingWithInput}
          maxLength={200}
          onChange={(event) => setSpendingWithInput(event.target.value)}
        />
        <p className="text-[11px] text-muted-foreground">
          Who you spent this money with — a client, vendor, or internal
          team. Leave blank if not applicable.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Business context</Label>
        <Textarea
          id="description"
          name="description"
          placeholder="Describe the expense and why it was necessary for business operations."
          value={descriptionInput}
          onChange={(event) => setDescriptionInput(event.target.value)}
          aria-invalid={Boolean(state.errors?.description)}
        />
        <FieldError message={state.errors?.description} />
      </div>

      {/* Payment type — who paid for this expense? */}
      <div className="space-y-2">
        <Label>Paid with</Label>
        <input type="hidden" name="paymentType" value={paymentType} />
        <div
          role="radiogroup"
          aria-label="Payment type"
          className="grid grid-cols-2 gap-2 rounded-2xl border border-border/70 bg-card/94 p-1 shadow-ambient"
        >
          {(
            [
              {
                value: "PERSONAL" as const,
                label: "My own money",
              },
              {
                value: "COMPANY" as const,
                label: "Company money",
              },
            ]
          ).map((option) => {
            const active = paymentType === option.value
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setPaymentType(option.value)}
                className={cn(
                  "flex flex-col items-start rounded-xl px-4 py-3 text-left text-sm font-semibold transition-colors",
                  active
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-surface-low hover:text-foreground"
                )}
              >
                <span>{option.label}</span>
                <span
                  className={cn(
                    "text-[11px] font-medium",
                    active ? "text-primary-foreground/80" : "text-muted-foreground"
                  )}
                >
                </span>
              </button>
            )
          })}
        </div>
        <FieldError message={state.errors?.paymentType} />
      </div>

      {paymentType === "COMPANY" ? (
        <div className="space-y-2">
          <Label htmlFor="payViaAccountId">Company bank account</Label>
          {bankAccounts.length === 0 ? (
            <div className="rounded-[20px] border border-amber-300/50 bg-amber-50/70 p-4 text-sm leading-6 text-amber-900 sm:rounded-[24px]">
              No company bank accounts have been enabled for claims yet. Ask your admin to select bank accounts in Settings → Accounts → Banks.
            </div>
          ) : (
            <Select
              name="payViaAccountId"
              value={payViaAccountId}
              onValueChange={setPayViaAccountId}
            >
              <SelectTrigger
                id="payViaAccountId"
                aria-invalid={Boolean(state.errors?.payViaAccountId)}
              >
                <SelectValue placeholder="Select company bank account" />
              </SelectTrigger>
              <SelectContent>
                {bankAccounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.code} · {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <FieldError message={state.errors?.payViaAccountId} />
        </div>
      ) : null}

      {claimRunPreview ? (
        <div className="rounded-[20px] border border-border/70 bg-card/94 p-4 text-sm leading-6 text-muted-foreground shadow-ambient backdrop-blur-sm sm:rounded-[24px] sm:p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">
            Claim run
          </p>
          <p className="mt-2 font-semibold text-foreground">
            {claimRunPreview.isCurrentMonth
              ? `Submit before day ${claimRunPreview.claimCutoffDay} to be included in the ${claimRunPreview.targetLabel} claims run.`
              : `This submission will be scheduled for the ${claimRunPreview.targetLabel} claims run because the cutoff is day ${claimRunPreview.claimCutoffDay}.`}
          </p>
        </div>
      ) : null}
    </>
  )

  // When the wizard already collected a receipt in step 2, replace the
  // big upload zone with a compact confirmation pill — the visible UI is
  // about telling the user "yes, your receipt is attached" rather than
  // letting them upload again. The hidden file input still renders so the
  // FormData carries the file on submit. To swap the photo, the user
  // hits "Back" in the wizard.
  const receiptAlreadyAttached = Boolean(prefilledReceiptFile)
  const receiptField = (
    <div className="space-y-2">
      <Label htmlFor="receiptFile">
        Receipt photo{" "}
        <span className="text-muted-foreground font-normal">(optional)</span>
      </Label>

      {receiptAlreadyAttached ? (
        <div className="flex items-center gap-3 rounded-2xl border border-emerald-300/50 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-900">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-200/70 text-emerald-900">
            ✓
          </span>
          <div className="flex-1 truncate">
            <p className="font-semibold">Receipt attached</p>
            <p className="truncate text-xs text-emerald-900/70">
              {selectedReceiptName || prefilledReceiptFile?.name}
            </p>
          </div>
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="text-xs font-semibold underline underline-offset-2 hover:text-emerald-950"
            >
              Replace
            </button>
          ) : null}
        </div>
      ) : (
        <label
          htmlFor="receiptFile"
          className="flex min-h-24 cursor-pointer flex-col items-center justify-center rounded-2xl border border-border/70 bg-card/94 px-4 py-5 text-center shadow-ambient backdrop-blur-sm transition-colors hover:border-primary/40 hover:bg-card"
        >
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Upload className="h-4 w-4" />
            <span>Upload photo</span>
            <span className="text-muted-foreground">or</span>
            <Camera className="h-4 w-4" />
            <span>take photo</span>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            JPG, PNG, WEBP, or HEIC up to 8 MB
          </p>
          {selectedReceiptName ? (
            <p className="mt-3 rounded-full bg-background px-3 py-1 text-xs font-medium text-foreground">
              {selectedReceiptName}
            </p>
          ) : null}
        </label>
      )}

      <input
        ref={receiptInputRef}
        suppressHydrationWarning
        id="receiptFile"
        name="receiptFile"
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        capture="environment"
        className="sr-only"
        onChange={(event) =>
          setSelectedReceiptName(event.target.files?.[0]?.name ?? "")
        }
      />
      <FieldError message={state.errors?.receiptUrl} />

      {/* Supporting documents — extras beyond the OCR'd primary
          receipt. Allowed types include PDFs / Office files so admins
          can attach quotations, invoices, approval emails, etc. */}
      <div className="space-y-2 pt-2">
        <Label htmlFor="supportingFile">
          Supporting documents{" "}
          <span className="text-muted-foreground font-normal">
            — optional, multiple files
          </span>
        </Label>
        <label
          htmlFor="supportingFile"
          className="flex min-h-20 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 bg-card/94 px-4 py-4 text-center shadow-ambient backdrop-blur-sm transition-colors hover:border-primary/40 hover:bg-card"
        >
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Upload className="h-4 w-4" />
            <span>Attach more files</span>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Quotations, invoices, emails. JPG, PNG, WEBP, HEIC, PDF, or
            Office files up to 8 MB each. Max 10 files.
          </p>
        </label>
        <input
          ref={supportingInputRef}
          id="supportingFile"
          name="supportingFile"
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain"
          className="sr-only"
          onChange={(event) => {
            const picked = Array.from(event.target.files ?? [])
            // Merge with existing files, dedupe by name+size,
            // cap at 10. The picker can be tapped multiple times
            // to add files in batches.
            setSupportingFiles((prev) => {
              const merged = [...prev]
              for (const f of picked) {
                const dup = merged.some(
                  (m) => m.name === f.name && m.size === f.size,
                )
                if (!dup) merged.push(f)
              }
              return merged.slice(0, 10)
            })
            // Reset the input's own .files to "" so re-picking the
            // same file works (browsers ignore the event otherwise).
            event.target.value = ""
          }}
        />
        {supportingFiles.length > 0 ? (
          <ul className="space-y-1.5">
            {supportingFiles.map((f, i) => (
              <li
                key={`${f.name}-${f.size}-${i}`}
                className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-1.5 text-xs"
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium text-foreground">
                    {f.name}
                  </span>
                  <span className="ml-2 text-muted-foreground">
                    {Math.max(1, Math.round(f.size / 1024))} KB
                  </span>
                </span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() =>
                    setSupportingFiles((prev) =>
                      prev.filter((_, idx) => idx !== i),
                    )
                  }
                  aria-label={`Remove ${f.name}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )

  const submitButton = (
    <Button
      type="submit"
      className="h-11 w-full rounded-2xl text-sm sm:h-12 sm:rounded-xl sm:text-base"
      disabled={pending || !canSubmit}
    >
      {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
      Submit claim
    </Button>
  )

  // Top-of-form error summary — shown only after a failed submit so we don't
  // spam the user before they've tried. Live over-limit warning is handled
  // inline next to the Amount field, not here.
  const errorBanner =
    state.status === "error" && allErrors.length > 0 ? (
      <div className="flex items-start gap-3 rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm leading-6 text-destructive">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="space-y-1">
          <p className="font-bold">Please fix the following before submitting:</p>
          <ul className="ml-4 list-disc space-y-0.5">
            {allErrors.map((message, index) => (
              <li key={`${index}-${message}`}>{message}</li>
            ))}
          </ul>
        </div>
      </div>
    ) : null

  // Optional back-link rendered at the top when ClaimFlow is in charge of
  // step orchestration. Plain button so screen readers don't think it's
  // submitting the form.
  const backLink = onBack ? (
    <button
      type="button"
      onClick={onBack}
      className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
    >
      ← Back
    </button>
  ) : null

  // Step indicator chip — renders just above the form when ClaimFlow is
  // active (signal: aiPrefill present OR onBack present).
  const stepChip =
    onBack ? (
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        Step 3 of 3 · Review &amp; submit
      </p>
    ) : null

  if (compact) {
    return (
      <form
        action={formAction}
        className="space-y-4 pb-2"
        suppressHydrationWarning
        onSubmitCapture={() => reattachPrefilledReceipt()}
      >
        {(backLink || stepChip) ? (
          <div className="flex items-center justify-between">
            {stepChip}
            {backLink}
          </div>
        ) : null}
        {errorBanner}
        <div className="space-y-5 rounded-[28px] border border-border/70 bg-card/90 p-5 shadow-sm">
          {mainFields}
        </div>
        <div className="space-y-5 rounded-[28px] border border-border/70 bg-card/90 p-5 shadow-sm">
          {receiptField}
        </div>
        {submitButton}
      </form>
    )
  }

  return (
    <form
      action={formAction}
      className="space-y-4 sm:space-y-6"
      suppressHydrationWarning
      onSubmitCapture={() => reattachPrefilledReceipt()}
    >
      {(backLink || stepChip) ? (
        <div className="flex items-center justify-between">
          {stepChip}
          {backLink}
        </div>
      ) : null}
      {errorBanner}
      <div className="grid gap-4 sm:gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardContent className="space-y-5 p-4 sm:space-y-6 sm:p-6">
            {mainFields}
          </CardContent>
        </Card>

        <div className="space-y-4 sm:space-y-6">
          <Card>
            <CardContent className="space-y-3 p-4 sm:space-y-4 sm:p-6">
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground sm:text-sm sm:tracking-[0.18em]">
                  {receiptAlreadyAttached ? "Receipt" : "Receipt optional"}
                </p>
                <p className="text-xs leading-6 text-muted-foreground sm:text-sm">
                  {receiptAlreadyAttached
                    ? "Already attached from the scan step. Hit Replace to swap it."
                    : "Upload a receipt photo now. On mobile, this can open the camera directly."}
                </p>
              </div>
              {receiptField}
            </CardContent>
          </Card>
          {submitButton}
        </div>
      </div>
    </form>
  )
}
