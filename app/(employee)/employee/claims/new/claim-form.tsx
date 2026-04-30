"use client"

import { useActionState, useEffect, useMemo, useState } from "react"
import { Camera, LoaderCircle, Upload } from "lucide-react"

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
import { cn } from "@/lib/utils"
import type { ClaimRunPreview } from "@/modules/claims/domain/models"
import type { ChartOfAccountOption } from "@/modules/organization/domain/models"

export function ClaimForm({
  chartAccounts,
  bankAccounts,
  claimRunPreview,
  organizationName,
  onSuccess,
  compact = false,
}: {
  chartAccounts: ChartOfAccountOption[]
  bankAccounts: ChartOfAccountOption[]
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
  const [selectedChartAccountId, setSelectedChartAccountId] = useState(
    state?.values?.chartOfAccountId ?? ""
  )
  const [paymentType, setPaymentType] = useState<"PERSONAL" | "COMPANY">(
    state?.values?.paymentType ?? "PERSONAL"
  )
  const [selectedBankAccountId, setSelectedBankAccountId] = useState(
    state?.values?.payViaAccountId ?? ""
  )

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
      onSuccess?.()
    }
  }, [state.status, onSuccess])

  // Reset bank-account selection whenever the user toggles back to PERSONAL.
  useEffect(() => {
    if (paymentType === "PERSONAL") {
      setSelectedBankAccountId("")
    }
  }, [paymentType])

  const selectedChartAccount = useMemo(
    () => chartAccounts.find((account) => account.id === selectedChartAccountId),
    [chartAccounts, selectedChartAccountId]
  )

  const canSubmit =
    chartAccounts.length > 0 &&
    (paymentType === "PERSONAL" ||
      (bankAccounts.length > 0 && selectedBankAccountId !== ""))

  // Shared field blocks used in both layouts
  const mainFields = (
    <>
      <div className="space-y-2">
        <Label htmlFor="title">Claim title</Label>
        <Input
          id="title"
          name="title"
          placeholder="Conference flight, client dinner, ride-share, office hardware..."
          defaultValue={state.values?.title ?? ""}
          aria-invalid={Boolean(state.errors?.title)}
        />
        {state.errors?.title ? (
          <p className="text-sm text-destructive">{state.errors.title}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="chartOfAccountId">Chart of account</Label>
        {chartAccounts.length === 0 ? (
          <div className="rounded-[20px] border border-amber-300/50 bg-amber-50/70 p-4 text-sm leading-6 text-amber-900 sm:rounded-[24px]">
            {organizationName
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
                <SelectValue placeholder="Select chart of account" />
              </SelectTrigger>
              <SelectContent>
                {chartAccounts.map((account) => (
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
              </div>
            ) : null}
          </div>
        )}
        {state.errors?.chartOfAccountId ? (
          <p className="text-sm text-destructive">{state.errors.chartOfAccountId}</p>
        ) : null}
      </div>

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
            defaultValue={state.values?.amount ?? ""}
            aria-invalid={Boolean(state.errors?.amount)}
          />
          {state.errors?.amount ? (
            <p className="text-sm text-destructive">{state.errors.amount}</p>
          ) : null}
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
          {state.errors?.spentAt ? (
            <p className="text-sm text-destructive">{state.errors.spentAt}</p>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Business context</Label>
        <Textarea
          id="description"
          name="description"
          placeholder="Describe the expense and why it was necessary for business operations."
          defaultValue={state.values?.description ?? ""}
          aria-invalid={Boolean(state.errors?.description)}
        />
        {state.errors?.description ? (
          <p className="text-sm text-destructive">{state.errors.description}</p>
        ) : null}
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
                hint: "Reimburse me",
              },
              {
                value: "COMPANY" as const,
                label: "Company money",
                hint: "No reimbursement",
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
                  {option.hint}
                </span>
              </button>
            )
          })}
        </div>
        {state.errors?.paymentType ? (
          <p className="text-sm text-destructive">{state.errors.paymentType}</p>
        ) : null}
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
          {state.errors?.payViaAccountId ? (
            <p className="text-sm text-destructive">{state.errors.payViaAccountId}</p>
          ) : null}
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
      {state.errors?.receiptUrl ? (
        <p className="text-sm text-destructive">{state.errors.receiptUrl}</p>
      ) : null}
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

  if (compact) {
    return (
      <form action={formAction} className="space-y-4 pb-2" suppressHydrationWarning>
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
