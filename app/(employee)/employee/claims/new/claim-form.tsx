"use client"

import { useActionState, useEffect, useMemo, useState } from "react"
import { Camera, LoaderCircle, Upload } from "lucide-react"

import { submitClaimAction } from "@/app/(employee)/employee/claims/new/actions"
import { initialClaimFormState } from "@/app/(employee)/employee/claims/new/form-state"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { ClaimRunPreview } from "@/modules/claims/domain/models"
import type { ChartOfAccountOption } from "@/modules/organization/domain/models"

export function ClaimForm({
  chartAccounts,
  claimRunPreview,
  organizationName,
}: {
  chartAccounts: ChartOfAccountOption[]
  claimRunPreview?: ClaimRunPreview
  organizationName?: string
}) {
  const [state, formAction, pending] = useActionState(
    submitClaimAction,
    initialClaimFormState
  )
  const [selectedReceiptName, setSelectedReceiptName] = useState("")
  const [selectedChartAccountId, setSelectedChartAccountId] = useState(
    chartAccounts[0]?.id ?? ""
  )

  useEffect(() => {
    if (state?.values?.chartOfAccountId) {
      setSelectedChartAccountId(state.values.chartOfAccountId)
    }
  }, [state?.values?.chartOfAccountId])

  useEffect(() => {
    if (!state?.values?.chartOfAccountId && chartAccounts[0]?.id) {
      setSelectedChartAccountId(chartAccounts[0].id)
    }
  }, [chartAccounts, state?.values?.chartOfAccountId])

  useEffect(() => {
    if (state.status === "success") {
      setSelectedReceiptName("")
    }
  }, [state.status])

  const selectedChartAccount = useMemo(
    () => chartAccounts.find((account) => account.id === selectedChartAccountId),
    [chartAccounts, selectedChartAccountId]
  )

  const canSubmit = chartAccounts.length > 0

  return (
    <form action={formAction} className="space-y-4 sm:space-y-6" suppressHydrationWarning>
      <div className="grid gap-4 sm:gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardContent className="space-y-5 p-4 sm:space-y-6 sm:p-6">
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

            <div className="space-y-3">
              <Label htmlFor="chartOfAccountId">Chart of account</Label>
              <div className="space-y-3">
                <select
                  id="chartOfAccountId"
                  name="chartOfAccountId"
                  suppressHydrationWarning
                  value={selectedChartAccountId}
                  onChange={(event) => setSelectedChartAccountId(event.target.value)}
                  aria-label="Select chart of account"
                  className="h-11 w-full rounded-xl border border-border/70 bg-card/94 px-4 text-base text-foreground shadow-ambient backdrop-blur-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ring-offset-background sm:text-sm"
                >
                  {chartAccounts.length === 0 ? (
                    <option value="">No enabled chart of account options yet</option>
                  ) : null}
                  {chartAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} · {account.name}
                    </option>
                  ))}
                </select>

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
                ) : (
                  <div className="rounded-[20px] border border-amber-300/50 bg-amber-50/70 p-4 text-sm leading-6 text-amber-900 sm:rounded-[24px]">
                    {organizationName
                      ? `No selectable chart of account has been enabled for ${organizationName} yet. Ask your admin to connect Xero and enable claim accounts in Settings.`
                      : "No selectable chart of account has been enabled yet. Ask your admin to connect Xero and enable claim accounts in Settings."}
                  </div>
                )}
              </div>
              {state.errors?.chartOfAccountId ? (
                <p className="text-sm text-destructive">{state.errors.chartOfAccountId}</p>
              ) : null}
            </div>

            <div className="grid gap-4 sm:gap-6 md:grid-cols-2">
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
              <div className="space-y-2">
                <Label htmlFor="receiptFile">Receipt photo</Label>
                <label
                  htmlFor="receiptFile"
                  className="flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-2xl border border-border/70 bg-card/94 px-4 py-5 text-center shadow-ambient backdrop-blur-sm transition-colors hover:border-primary/40 hover:bg-card"
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
            </CardContent>
          </Card>

          <Button
            type="submit"
            className="h-11 w-full rounded-2xl text-sm sm:h-12 sm:rounded-xl sm:text-base"
            disabled={pending || !canSubmit}
          >
            {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
            Submit claim
          </Button>
        </div>
      </div>
    </form>
  )
}
