"use client"

import { useActionState, useEffect, useMemo, useState } from "react"
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

export function ClaimForm({
  chartAccounts,
  mileageAccounts,
  bankAccounts,
  defaultMileageRate,
  mileageUnit,
  claimRunPreview,
  organizationName,
  onSuccess,
  compact = false,
}: {
  chartAccounts: ChartAccountWithRemainingLimit[]
  mileageAccounts: ChartAccountWithRemainingLimit[]
  bankAccounts: ChartOfAccountOption[]
  defaultMileageRate?: number
  mileageUnit: "KM" | "MILE"
  claimRunPreview?: ClaimRunPreview
  organizationName?: string
  onSuccess?: () => void
  compact?: boolean
}) {
  const [state, formAction, pending] = useActionState(
    submitClaimAction,
    initialClaimFormState
  )
  const [selectedReceiptName, setSelectedReceiptName] = useState("")
  const [claimType, setClaimType] = useState<"EXPENSE" | "MILEAGE">(
    state?.values?.claimType ?? "EXPENSE"
  )
  const [selectedChartAccountId, setSelectedChartAccountId] = useState(
    state?.values?.chartOfAccountId ?? ""
  )
  const [paymentType, setPaymentType] = useState<"PERSONAL" | "COMPANY">(
    state?.values?.paymentType ?? "PERSONAL"
  )
  const [selectedBankAccountId, setSelectedBankAccountId] = useState(
    state?.values?.payViaAccountId ?? ""
  )
  const [distance, setDistance] = useState(state?.values?.distance ?? "")
  // Track amount as state so we can run live limit validation while the user
  // types — a controlled input lets us re-compute `liveAmount` per keystroke.
  const [amountInput, setAmountInput] = useState(state?.values?.amount ?? "")

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
      setSelectedBankAccountId("")
      setClaimType("EXPENSE")
      setDistance("")
      setAmountInput("")
      onSuccess?.()
    }
  }, [state.status, onSuccess])

  // Re-sync amount with the server-returned sticky value after a failed submit
  // so the form preserves the user's last typed value.
  useEffect(() => {
    if (state.values?.amount !== undefined) {
      setAmountInput(state.values.amount)
    }
  }, [state.values?.amount])

  // Reset bank-account selection whenever the user toggles back to PERSONAL.
  useEffect(() => {
    if (paymentType === "PERSONAL") {
      setSelectedBankAccountId("")
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
    (paymentType === "PERSONAL" ||
      (bankAccounts.length > 0 && selectedBankAccountId !== "")) &&
    (claimType === "EXPENSE" || resolvedMileageRate > 0)

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
  // of the form. Live over-limit gets prepended even though it's not in
  // state.errors yet — the user shouldn't have to submit to see it.
  const allErrors = [
    overLimit
      ? `Amount ${liveAmount.toFixed(2)} exceeds the remaining limit of ${remaining!.remaining.toFixed(2)}.`
      : null,
    state.errors?.title,
    state.errors?.chartOfAccountId,
    state.errors?.amount,
    state.errors?.distance,
    state.errors?.mileageOriginAddress,
    state.errors?.mileageDestinationAddress,
    state.errors?.spentAt,
    state.errors?.description,
    state.errors?.payViaAccountId,
    state.errors?.receiptUrl,
  ].filter((message): message is string => Boolean(message))

  // Shared field blocks used in both layouts
  const mainFields = (
    <>
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
          defaultValue={state.values?.title ?? ""}
          aria-invalid={Boolean(state.errors?.title)}
        />
        <FieldError message={state.errors?.title} />
      </div>

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
          <div className="grid gap-4 sm:grid-cols-2">
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

            <div className="space-y-2">
              <Label htmlFor="spentAt">Expense date</Label>
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

          {/* Live over-limit warning. Surfaces the same check the server runs
              so the user sees it before pressing Submit. */}
          {overLimit && remaining ? (
            <div className="flex items-start gap-2 rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm leading-6 text-destructive">
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
                . Reduce the amount, choose a different account, or speak to your admin
                to raise the cap.
              </span>
            </div>
          ) : null}
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="description">Business context</Label>
        <Textarea
          id="description"
          name="description"
          placeholder="Describe the expense and why it was necessary for business operations."
          defaultValue={state.values?.description ?? ""}
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
          <Label htmlFor="payViaAccountId">Company bank account used</Label>
          {bankAccounts.length === 0 ? (
            <div className="rounded-[20px] border border-amber-300/50 bg-amber-50/70 p-4 text-sm leading-6 text-amber-900 sm:rounded-[24px]">
              No company bank accounts are configured yet. Ask your admin to add
              bank accounts in Settings before submitting a company-money claim.
            </div>
          ) : (
            <>
              <input
                type="hidden"
                name="payViaAccountId"
                value={selectedBankAccountId}
              />
              <Select
                value={selectedBankAccountId}
                onValueChange={setSelectedBankAccountId}
              >
                <SelectTrigger
                  id="payViaAccountId"
                  aria-invalid={Boolean(state.errors?.payViaAccountId)}
                >
                  <SelectValue placeholder="Select bank account" />
                </SelectTrigger>
                <SelectContent>
                  {bankAccounts.map((bank) => (
                    <SelectItem key={bank.id} value={bank.id}>
                      {bank.code} · {bank.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
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

  const receiptField = (
    <div className="space-y-2">
      <Label htmlFor="receiptFile">Receipt photo <span className="text-muted-foreground font-normal">(optional)</span></Label>
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
      <input
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
    </div>
  )

  const submitButton = (
    <Button
      type="submit"
      className="h-11 w-full rounded-2xl text-sm sm:h-12 sm:rounded-xl sm:text-base"
      disabled={pending || !canSubmit || overLimit}
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

  if (compact) {
    return (
      <form action={formAction} className="space-y-4 pb-2" suppressHydrationWarning>
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
    <form action={formAction} className="space-y-4 sm:space-y-6" suppressHydrationWarning>
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
                  Receipt optional
                </p>
                <p className="text-xs leading-6 text-muted-foreground sm:text-sm">
                  Upload a receipt photo now. On mobile, this can open the camera directly.
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
