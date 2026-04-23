"use client"

import { useActionState, useEffect, useState } from "react"
import { Camera, LoaderCircle, Upload } from "lucide-react"

import { submitClaimAction } from "@/app/(employee)/employee/claims/new/actions"
import { initialClaimFormState } from "@/app/(employee)/employee/claims/new/form-state"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { categoryMeta } from "@/modules/claims/domain/metadata"
import {
  claimCategories,
  type ClaimCategory,
} from "@/modules/claims/domain/models"

export function ClaimForm() {
  const [state, formAction, pending] = useActionState(
    submitClaimAction,
    initialClaimFormState
  )
  const [selectedCategory, setSelectedCategory] = useState<ClaimCategory>("TRAVEL")
  const [selectedReceiptName, setSelectedReceiptName] = useState("")

  useEffect(() => {
    if (state?.values?.category) {
      setSelectedCategory(state.values.category)
    }
  }, [state?.values?.category])

  useEffect(() => {
    if (state.status === "success") {
      setSelectedReceiptName("")
    }
  }, [state.status])

  return (
    <form action={formAction} className="space-y-4 sm:space-y-6" suppressHydrationWarning>
      <input type="hidden" name="category" value={selectedCategory} suppressHydrationWarning />

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
              <Label>Category</Label>
              <div className="sm:hidden">
                <select
                  suppressHydrationWarning
                  value={selectedCategory}
                  onChange={(event) =>
                    setSelectedCategory(event.target.value as ClaimCategory)
                  }
                  aria-label="Select claim category"
                  className="h-11 w-full rounded-xl border border-transparent bg-surface-low px-4 text-base text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ring-offset-background sm:text-sm"
                >
                  {claimCategories.map((category) => (
                    <option key={category} value={category}>
                      {categoryMeta[category].label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="hidden gap-2.5 sm:grid sm:grid-cols-2 sm:gap-3">
                {claimCategories.map((category) => (
                  <button
                    key={category}
                    type="button"
                    onClick={() => setSelectedCategory(category)}
                    className={cn(
                      "rounded-[20px] border p-3 text-left transition-all sm:rounded-[24px] sm:p-4",
                      selectedCategory === category
                        ? "border-primary bg-primary/5 shadow-ambient"
                        : "border-transparent bg-surface-low hover:border-border"
                    )}
                  >
                    <p className="text-sm font-bold sm:text-base">{categoryMeta[category].label}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground sm:text-sm sm:leading-6">
                      {categoryMeta[category].description}
                    </p>
                  </button>
                ))}
              </div>
              {state.errors?.category ? (
                <p className="text-sm text-destructive">{state.errors.category}</p>
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
                  className="flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-surface-low px-4 py-5 text-center transition-colors hover:border-primary/40 hover:bg-surface"
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
            disabled={pending}
          >
            {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
            Submit claim
          </Button>
        </div>
      </div>
    </form>
  )
}
