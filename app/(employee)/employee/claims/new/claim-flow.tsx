"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { safeErrorMessage } from "@/lib/errors"
import {
  ArrowLeft,
  Building2,
  Camera,
  CircleAlert,
  FileText,
  Loader2,
  MapPin,
  Receipt,
  RefreshCw,
  Sparkles,
  Upload,
  Wallet,
} from "lucide-react"

import {
  ClaimForm,
  type ClaimFormAiPrefill,
} from "@/app/(employee)/employee/claims/new/claim-form"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type {
  ChartAccountWithRemainingLimit,
  ClaimRunPreview,
} from "@/modules/claims/domain/models"
import type { ChartOfAccountOption } from "@/modules/organization/domain/models"

type ClaimFlowStep = "payment" | "type" | "receipt" | "form"
type ClaimType = "EXPENSE" | "MILEAGE"
type PaymentType = "PERSONAL" | "COMPANY"

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
 * Wizard:
 *   1. payment → pick Personal (own money) or Company money.
 *   2. type → pick Expense or Mileage.
 *   3. receipt → (Expense only) upload, OCR with Tesseract, AI extraction.
 *   4. form → render the existing ClaimForm with prefilled values.
 *
 * Mileage skips the receipt step. The user can also "Skip and fill
 * manually" on the receipt step. The payment-type choice from step 1 is
 * passed into the form and locked there (shown as a read-only summary).
 *
 * State lives entirely in this component; the form's server action is
 * untouched. Submission failures rerun the form with sticky values; AI
 * prefill is overridden by sticky values to avoid clobbering edits.
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
  const [step, setStep] = useState<ClaimFlowStep>("payment")
  const [paymentType, setPaymentType] = useState<PaymentType | null>(null)
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

  const handlePickPayment = useCallback((type: PaymentType) => {
    setPaymentType(type)
    setStep("type")
  }, [])

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
      {step === "payment" ? <PaymentStep onPick={handlePickPayment} /> : null}

      {step === "type" ? (
        <TypeStep
          onPick={handlePickType}
          onBack={() => {
            setClaimType(null)
            setStep("payment")
          }}
        />
      ) : null}

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

      {step === "form" && claimType && paymentType ? (
        <ClaimForm
          {...props}
          defaultClaimType={claimType}
          defaultPaymentType={paymentType}
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
// Step 1: Payment source picker (Personal vs Company money)
// ----------------------------------------------------------------------------

function PaymentStep({ onPick }: { onPick: (type: PaymentType) => void }) {
  // Step body intentionally NOT wrapped in <Card>. The wizard already
  // lives inside the parent Dialog (or page chrome) which provides
  // the rounded white surface — wrapping again here doubled the
  // border + shrunk the content on phones.
  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Step 1 · How was this paid?
        </p>
        <h2 className="mt-2 text-xl font-semibold sm:text-2xl">
          Who paid for this?
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick whether you paid out of your own pocket (to be reimbursed) or
          it was paid with company money.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <TypeCard
          icon={<Wallet className="h-5 w-5" />}
          title="My own money"
          description="You paid personally and need to be reimbursed — via payroll or a bill."
          onClick={() => onPick("PERSONAL")}
        />
        <TypeCard
          icon={<Building2 className="h-5 w-5" />}
          title="Company money"
          description="Already paid from a company card or bank account — recorded as a company spend."
          onClick={() => onPick("COMPANY")}
        />
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Step 1: Type picker
// ----------------------------------------------------------------------------

function TypeStep({
  onPick,
  onBack,
}: {
  onPick: (type: ClaimType) => void
  onBack: () => void
}) {
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Step 2 · Pick a claim type
          </p>
          <h2 className="mt-2 text-xl font-semibold sm:text-2xl">
            What kind of claim is this?
          </h2>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Back
        </Button>
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
    </div>
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
      const isPdf = receiptFile.type === "application/pdf"

      let payload: AnalyzeApiResponse

      if (isPdf) {
        // PDFs skip Tesseract entirely — we upload the file and let
        // Gemini's multimodal endpoint do OCR + extraction in one call.
        // Tesseract.js doesn't render PDFs out-of-the-box, and PDFs
        // usually have selectable text + structure that Gemini reads
        // far more accurately than rasterise-then-OCR would.
        setStatus({ phase: "ai" })

        const formData = new FormData()
        formData.append("file", receiptFile)

        const response = await fetch("/api/ocr/analyze-receipt-file", {
          method: "POST",
          body: formData,
        })

        payload = (await response.json().catch(() => ({}))) as AnalyzeApiResponse
        if (!response.ok || !payload.extraction) {
          const fallbackMessage =
            payload.error ??
            "AI extraction failed. You can still continue and fill the form manually."
          setStatus({ phase: "error", message: fallbackMessage })
          return
        }
      } else {
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

        payload = (await response.json().catch(() => ({}))) as AnalyzeApiResponse
        if (!response.ok || !payload.extraction) {
          const fallbackMessage =
            payload.error ??
            "AI extraction failed. You can still continue and fill the form manually."
          setStatus({ phase: "error", message: fallbackMessage })
          return
        }
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
        safeErrorMessage(error, "Receipt scan failed.")
      setStatus({ phase: "error", message })
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Step 3 · Scan the receipt
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
          receiptFile?.type === "application/pdf" ? (
            <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
              <FileText className="h-10 w-10 text-muted-foreground" aria-hidden />
              <p className="text-sm font-semibold text-foreground">
                {receiptFile.name || "PDF receipt"}
              </p>
              <p className="text-xs text-muted-foreground">
                PDF will be read by AI — no on-device preview.
              </p>
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={receiptPreview}
              alt="Receipt preview"
              className="max-h-64 rounded-xl object-contain"
            />
          )
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
              JPG, PNG, WEBP, HEIC, or PDF up to 8 MB
            </p>
          </>
        )}
      </label>
      <input
        id="receiptScanFile"
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
        // NB: no `capture` attribute. iOS Safari and most Android
        // browsers treat `capture` as "open camera directly, hide
        // library" — so users couldn't pick an existing photo. With
        // it removed, the mobile picker shows BOTH "Take photo" and
        // "Photo library" / "Choose file" entries, matching the
        // behaviour of the Supporting documents input below.
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
    </div>
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
