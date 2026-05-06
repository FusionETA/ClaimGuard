"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  ArrowLeft,
  Camera,
  CircleAlert,
  FileText,
  Loader2,
  MapPin,
  Receipt,
  RefreshCw,
  Sparkles,
  Upload,
} from "lucide-react"

import {
  ClaimForm,
  type ClaimFormAiPrefill,
} from "@/app/(employee)/employee/claims/new/claim-form"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { cn } from "@/lib/utils"
import type {
  ChartAccountWithRemainingLimit,
  ClaimRunPreview,
} from "@/modules/claims/domain/models"
import type { ChartOfAccountOption } from "@/modules/organization/domain/models"

type ClaimFlowStep = "type" | "receipt" | "form"
type ClaimType = "EXPENSE" | "MILEAGE"

type AnalyzeApiResponse = {
  extraction?: {
    supplier: string | null
    total: number | null
    date: string | null
    description: string | null
    detectedCurrency: string | null
    resolvedCurrency: string | null
    currencyWasOverridden: boolean
    suggestedAccountId: string | null
    suggestedAccountConfidence: number
    provider: string
  }
  error?: string
}

/** Module-level lazy load for Tesseract.js. The library is ~2 MB so we
 *  only fetch it once the user lands on the receipt step, and cache the
 *  promise so subsequent uploads reuse the same instance. */
let tesseractLoader: Promise<typeof import("tesseract.js")> | null = null
function loadTesseract() {
  if (!tesseractLoader) {
    tesseractLoader = import("tesseract.js")
  }
  return tesseractLoader
}

/**
 * Three-step wizard:
 *   1. type → pick Expense or Mileage.
 *   2. receipt → (Expense only) upload, OCR with Tesseract, AI extraction.
 *   3. form → render the existing ClaimForm with prefilled values.
 *
 * Mileage skips step 2 entirely. The user can also "Skip and fill manually"
 * on step 2 — useful when the OCR is being unreliable or they don't have
 * a clear photo.
 *
 * State lives entirely in this component; the form's server action is
 * untouched. Submission failures rerun the form in step 3 with sticky
 * values, AI prefill is overridden by sticky values to avoid clobbering
 * the user's edits.
 */
export function ClaimFlow(props: {
  chartAccounts: ChartAccountWithRemainingLimit[]
  mileageAccounts: ChartAccountWithRemainingLimit[]
  bankAccounts: ChartOfAccountOption[]
  defaultMileageRate?: number
  mileageUnit: "KM" | "MILE"
  claimRunPreview?: ClaimRunPreview
  organizationName?: string
  employeeProjects?: Array<{ id: string; name: string }>
  allowedCurrencies?: string[]
  defaultCurrency?: string
  onSuccess?: () => void
  compact?: boolean
}) {
  const [step, setStep] = useState<ClaimFlowStep>("type")
  const [claimType, setClaimType] = useState<ClaimType | null>(null)
  const [aiPrefill, setAiPrefill] = useState<ClaimFormAiPrefill | undefined>()
  const [receiptFile, setReceiptFile] = useState<File | null>(null)
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null)

  // Cleanup the object URL when the component unmounts or file changes,
  // otherwise we leak memory after every retake.
  useEffect(() => {
    return () => {
      if (receiptPreview) URL.revokeObjectURL(receiptPreview)
    }
  }, [receiptPreview])

  const handlePickType = useCallback((type: ClaimType) => {
    setClaimType(type)
    if (type === "MILEAGE") {
      // Mileage has no receipt — go straight to the form.
      setStep("form")
    } else {
      setStep("receipt")
    }
  }, [])

  const handleSkipReceipt = useCallback(() => {
    setAiPrefill(undefined)
    setStep("form")
  }, [])

  return (
    <div className="space-y-4">
      {step === "type" ? <TypeStep onPick={handlePickType} /> : null}

      {step === "receipt" ? (
        <ReceiptStep
          onComplete={(prefill, file) => {
            setAiPrefill(prefill)
            setReceiptFile(file)
            setStep("form")
          }}
          onSkip={handleSkipReceipt}
          onBack={() => {
            setClaimType(null)
            setStep("type")
          }}
          receiptFile={receiptFile}
          receiptPreview={receiptPreview}
          setReceiptFile={setReceiptFile}
          setReceiptPreview={setReceiptPreview}
        />
      ) : null}

      {step === "form" && claimType ? (
        <ClaimForm
          {...props}
          defaultClaimType={claimType}
          aiPrefill={aiPrefill}
          prefilledReceiptFile={receiptFile}
          onBack={() => {
            // Mileage path returns to the type picker; expense path
            // returns to the receipt step (preserving the upload).
            if (claimType === "MILEAGE") {
              setClaimType(null)
              setStep("type")
            } else {
              setStep("receipt")
            }
          }}
        />
      ) : null}
    </div>
  )
}

// ----------------------------------------------------------------------------
// Step 1: Type picker
// ----------------------------------------------------------------------------

function TypeStep({ onPick }: { onPick: (type: ClaimType) => void }) {
  return (
    <Card>
      <CardContent className="space-y-5 p-5 sm:p-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Step 1 of {3} · Pick a claim type
          </p>
          <h2 className="mt-2 text-xl font-semibold sm:text-2xl">
            What kind of claim is this?
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Expense claims need a receipt photo we can scan. Mileage claims are
            entered manually with distance and route.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <TypeCard
            icon={<Receipt className="h-5 w-5" />}
            title="Expense claim"
            description="Snap a receipt — we'll read it and pre-fill amount, date, supplier, and description for you."
            onClick={() => onPick("EXPENSE")}
          />
          <TypeCard
            icon={<MapPin className="h-5 w-5" />}
            title="Mileage claim"
            description="Enter distance, origin, and destination. The amount is calculated from your org's mileage rate."
            onClick={() => onPick("MILEAGE")}
          />
        </div>
      </CardContent>
    </Card>
  )
}

function TypeCard({
  icon,
  title,
  description,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-start gap-3 rounded-2xl border border-border/70 bg-card/94 p-5 text-left shadow-ambient transition-all hover:border-primary/60 hover:shadow-lg"
    >
      <div className="rounded-xl bg-primary/10 p-2 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
        {icon}
      </div>
      <div>
        <p className="font-bold text-foreground">{title}</p>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
    </button>
  )
}

// ----------------------------------------------------------------------------
// Step 2: Receipt upload + OCR + AI
// ----------------------------------------------------------------------------

type ReceiptStatus =
  | { phase: "idle" }
  | { phase: "ocr"; progress: number }
  | { phase: "ai" }
  | { phase: "error"; message: string }

function ReceiptStep({
  receiptFile,
  receiptPreview,
  setReceiptFile,
  setReceiptPreview,
  onComplete,
  onSkip,
  onBack,
}: {
  receiptFile: File | null
  receiptPreview: string | null
  setReceiptFile: (file: File | null) => void
  setReceiptPreview: (url: string | null) => void
  onComplete: (prefill: ClaimFormAiPrefill, file: File) => void
  onSkip: () => void
  onBack: () => void
}) {
  const [status, setStatus] = useState<ReceiptStatus>({ phase: "idle" })
  // Track the last filename we ran extraction against, so re-uploading the
  // same file doesn't auto-rescan in a loop after a failure.
  const lastProcessedRef = useRef<string | null>(null)

  function handleFile(file: File) {
    if (receiptPreview) URL.revokeObjectURL(receiptPreview)
    const url = URL.createObjectURL(file)
    setReceiptPreview(url)
    setReceiptFile(file)
    lastProcessedRef.current = null
    setStatus({ phase: "idle" })
  }

  async function runExtraction() {
    if (!receiptFile) return

    try {
      // 1. OCR via Tesseract.js (browser-side, free).
      setStatus({ phase: "ocr", progress: 0 })
      const Tesseract = await loadTesseract()

      const ocr = await Tesseract.recognize(receiptFile, "eng", {
        logger: (m: { status: string; progress: number }) => {
          if (m.status === "recognizing text") {
            setStatus({ phase: "ocr", progress: m.progress })
          }
        },
      })

      const text = ocr.data?.text?.trim() ?? ""
      if (!text) {
        setStatus({
          phase: "error",
          message:
            "Couldn't read any text from the photo. Try a sharper or better-lit shot, or skip and fill manually.",
        })
        return
      }

      // 2. AI extraction via the server route.
      setStatus({ phase: "ai" })
      const response = await fetch("/api/ocr/analyze-receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      })

      const payload = (await response.json().catch(() => ({}))) as AnalyzeApiResponse
      if (!response.ok || !payload.extraction) {
        const fallbackMessage =
          payload.error ?? "AI extraction failed. You can still continue and fill the form manually."
        setStatus({ phase: "error", message: fallbackMessage })
        return
      }

      const e = payload.extraction
      const prefill: ClaimFormAiPrefill = {
        title: e.supplier ?? undefined,
        amount:
          typeof e.total === "number" && Number.isFinite(e.total)
            ? e.total.toFixed(2)
            : undefined,
        spentAt: e.date ?? undefined,
        description: e.description ?? undefined,
        currency: e.resolvedCurrency ?? undefined,
        chartOfAccountId: e.suggestedAccountId ?? undefined,
      }

      lastProcessedRef.current = receiptFile.name
      onComplete(prefill, receiptFile)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Receipt scan failed."
      setStatus({ phase: "error", message })
    }
  }

  return (
    <Card>
      <CardContent className="space-y-5 p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Step 2 of 3 · Scan the receipt
            </p>
            <h2 className="mt-2 text-xl font-semibold sm:text-2xl">
              Upload your receipt
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              We&rsquo;ll read it on your device, then ask the AI to fill in the form.
            </p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Back
          </Button>
        </div>

        <label
          htmlFor="receiptScanFile"
          className={cn(
            "flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border/70 bg-card/94 px-4 py-6 text-center shadow-ambient transition-colors hover:border-primary/40 hover:bg-card",
            receiptPreview && "border-solid",
          )}
        >
          {receiptPreview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={receiptPreview}
              alt="Receipt preview"
              className="max-h-64 rounded-xl object-contain"
            />
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Upload className="h-4 w-4" />
                <span>Upload photo</span>
                <span className="text-muted-foreground">or</span>
                <Camera className="h-4 w-4" />
                <span>take photo</span>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                JPG, PNG, WEBP, or HEIC up to 8 MB
              </p>
            </>
          )}
        </label>
        <input
          id="receiptScanFile"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          capture="environment"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) handleFile(file)
          }}
        />

        {status.phase === "ocr" ? (
          <ProgressRow
            icon={<FileText className="h-4 w-4" />}
            label={`Reading text from photo… ${Math.round(status.progress * 100)}%`}
            progress={status.progress}
          />
        ) : null}

        {status.phase === "ai" ? (
          <ProgressRow
            icon={<Sparkles className="h-4 w-4" />}
            label="AI is extracting the bill details…"
          />
        ) : null}

        {status.phase === "error" ? (
          <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{status.message}</span>
          </div>
        ) : null}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button type="button" variant="ghost" onClick={onSkip}>
            Skip — fill manually
          </Button>
          <div className="flex gap-2">
            {receiptFile && status.phase !== "ocr" && status.phase !== "ai" ? (
              <Button
                type="button"
                onClick={runExtraction}
                className="rounded-xl"
              >
                {status.phase === "error" ? (
                  <>
                    <RefreshCw className="mr-1.5 h-4 w-4" />
                    Try again
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-1.5 h-4 w-4" />
                    Extract with AI
                  </>
                )}
              </Button>
            ) : null}
            {status.phase === "ocr" || status.phase === "ai" ? (
              <Button type="button" disabled className="rounded-xl">
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                Working…
              </Button>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function ProgressRow({
  icon,
  label,
  progress,
}: {
  icon: React.ReactNode
  label: string
  progress?: number
}) {
  return (
    <div className="space-y-2 rounded-xl border border-border/70 bg-surface-low px-4 py-3 text-sm">
      <div className="flex items-center gap-2 text-foreground">
        <span className="text-primary">{icon}</span>
        <span className="font-medium">{label}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-border/50">
        <div
          className={cn(
            "h-full bg-primary transition-all",
            progress === undefined && "animate-pulse",
          )}
          style={{
            width:
              progress === undefined
                ? "100%"
                : `${Math.max(4, Math.round(progress * 100))}%`,
          }}
        />
      </div>
    </div>
  )
}
