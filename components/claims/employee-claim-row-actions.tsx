"use client"

import { useActionState, useEffect, useRef, useState } from "react"
import {
  Loader2,
  Paperclip,
  Pencil,
  Trash2,
  X,
} from "lucide-react"

import {
  addSupportingFilesAction,
  deleteClaimAction,
  replaceReceiptAction,
  updateClaimAction,
} from "@/app/(employee)/employee/claims/actions"
import {
  initialAttachClaimFilesFormState,
  initialDeleteClaimFormState,
  initialReplaceReceiptFormState,
  initialUpdateClaimFormState,
} from "@/app/(employee)/employee/claims/form-state"
import { ClaimStatusBadge } from "@/components/claims/claim-status-badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useToastOnAction } from "@/components/ui/toaster"
import {
  formatCurrency,
  formatMonthYear,
  formatShortDate,
} from "@/lib/utils"
import type { ClaimRecord } from "@/modules/claims/domain/models"

const STATUSES_OPEN_TO_EDIT: ReadonlyArray<ClaimRecord["status"]> = [
  "SUBMITTED",
  "PENDING",
]

type EmployeeClaimRowActionsProps = {
  claim: ClaimRecord
}

/**
 * Row-end pencil button for /employee/claims. Opens a Dialog with:
 *   - the claim's editable fields (title / amount / date / context
 *     text) as an inline form, when the claim is still SUBMITTED or
 *     PENDING; same fields render read-only once it's gone to review;
 *   - read-only context (account, payment, currency, receipt,
 *     supporting attachments, reviewer note);
 *   - "Attach more documents" (file picker + submit) — same edit
 *     window;
 *   - "Delete claim" (confirm step) — same edit window.
 *
 * Once an approver has acted (APPROVED / REVIEWED / REJECTED), the
 * row becomes audit history and the dialog drops the editable form,
 * the attach-more block, and the delete button — only Close remains.
 */
export function EmployeeClaimRowActions({
  claim,
}: EmployeeClaimRowActionsProps) {
  const editable = STATUSES_OPEN_TO_EDIT.includes(claim.status)
  const [open, setOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const attachInputRef = useRef<HTMLInputElement | null>(null)
  const [attachFiles, setAttachFiles] = useState<File[]>([])

  const [updateState, updateFormAction, updatePending] = useActionState(
    updateClaimAction,
    initialUpdateClaimFormState,
  )
  useToastOnAction(updateState)

  const [deleteState, deleteFormAction, deletePending] = useActionState(
    deleteClaimAction,
    initialDeleteClaimFormState,
  )
  useToastOnAction(deleteState)

  const [attachState, attachFormAction, attachPending] = useActionState(
    addSupportingFilesAction,
    initialAttachClaimFilesFormState,
  )
  useToastOnAction(attachState)

  const [replaceReceiptState, replaceReceiptFormAction, replaceReceiptPending] =
    useActionState(replaceReceiptAction, initialReplaceReceiptFormState)
  useToastOnAction(replaceReceiptState)
  const receiptInputRef = useRef<HTMLInputElement | null>(null)
  const [pendingReceipt, setPendingReceipt] = useState<File | null>(null)

  // Close dialog on a successful delete.
  useEffect(() => {
    if (deleteState.status === "success") {
      setOpen(false)
      setConfirmDelete(false)
    }
  }, [deleteState])

  // Reset the file picker on a successful upload — keep the dialog
  // open so the user can see the just-attached files in the list.
  useEffect(() => {
    if (attachState.status === "success") {
      setAttachFiles([])
      if (attachInputRef.current) attachInputRef.current.value = ""
    }
  }, [attachState])

  // Clear the pending receipt picker after a successful swap.
  useEffect(() => {
    if (replaceReceiptState.status === "success") {
      setPendingReceipt(null)
      if (receiptInputRef.current) receiptInputRef.current.value = ""
    }
  }, [replaceReceiptState])

  // Mirror the controlled pending-receipt file into the hidden input
  // so the form action receives it.
  useEffect(() => {
    const input = receiptInputRef.current
    if (!input) return
    const dt = new DataTransfer()
    if (pendingReceipt) dt.items.add(pendingReceipt)
    input.files = dt.files
  }, [pendingReceipt])

  // Mirror controlled file list into the hidden FileList on submit.
  useEffect(() => {
    const input = attachInputRef.current
    if (!input) return
    const dt = new DataTransfer()
    for (const f of attachFiles) dt.items.add(f)
    input.files = dt.files
  }, [attachFiles])

  const supportingCount = claim.supportingAttachments?.length ?? 0
  const errors = updateState.fieldErrors

  // <input type="date"> needs `yyyy-mm-dd`. `claim.spentAt` is ISO.
  const initialSpentAt = claim.spentAt ? claim.spentAt.slice(0, 10) : ""

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={editable ? "Edit claim" : "View claim details"}
        title={editable ? "Edit claim" : "View claim details"}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
        className="h-8 w-8 rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      >
        <Pencil className="h-4 w-4" />
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setConfirmDelete(false)
        }}
      >
        <DialogContent className="flex max-h-[88vh] w-[min(94vw,680px)] flex-col overflow-hidden sm:max-w-[680px]">
          <DialogHeader className="shrink-0 border-b border-border/60 pb-3 pr-8">
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <span>{editable ? "Edit claim" : claim.title}</span>
              <ClaimStatusBadge status={claim.status} />
            </DialogTitle>
            <DialogDescription className="font-mono text-[11px] uppercase tracking-[0.18em]">
              {claim.claimNumber}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 space-y-5 overflow-y-auto px-1 pt-4">
            {editable ? (
              <form
                action={updateFormAction}
                className="space-y-3"
                id={`edit-claim-${claim.id}`}
              >
                <input type="hidden" name="claimId" value={claim.id} />

                <div className="space-y-1.5">
                  <Label htmlFor={`title-${claim.id}`}>Title</Label>
                  <Input
                    id={`title-${claim.id}`}
                    name="title"
                    defaultValue={claim.title}
                    aria-invalid={errors?.title ? true : undefined}
                    required
                  />
                  {errors?.title ? (
                    <p className="text-xs text-destructive">{errors.title}</p>
                  ) : null}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={`amount-${claim.id}`}>
                      Amount ({claim.currency})
                    </Label>
                    <Input
                      id={`amount-${claim.id}`}
                      name="amount"
                      type="number"
                      step="0.01"
                      min="0.01"
                      defaultValue={claim.amount.toFixed(2)}
                      aria-invalid={errors?.amount ? true : undefined}
                      required
                    />
                    {errors?.amount ? (
                      <p className="text-xs text-destructive">{errors.amount}</p>
                    ) : null}
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor={`spentAt-${claim.id}`}>Spent on</Label>
                    <Input
                      id={`spentAt-${claim.id}`}
                      name="spentAt"
                      type="date"
                      defaultValue={initialSpentAt}
                      aria-invalid={errors?.spentAt ? true : undefined}
                      required
                    />
                    {errors?.spentAt ? (
                      <p className="text-xs text-destructive">
                        {errors.spentAt}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor={`spendingAt-${claim.id}`}>
                    Spending at{" "}
                    <span className="text-muted-foreground">
                      {claim.paymentType === "COMPANY" ? "— required" : "— optional"}
                    </span>
                  </Label>
                  <Input
                    id={`spendingAt-${claim.id}`}
                    name="spendingAt"
                    placeholder="e.g. Starbucks KLCC"
                    defaultValue={claim.spendingAt ?? ""}
                    aria-invalid={errors?.spendingAt ? true : undefined}
                  />
                  {errors?.spendingAt ? (
                    <p className="text-xs text-destructive">
                      {errors.spendingAt}
                    </p>
                  ) : null}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor={`spendingWith-${claim.id}`}>
                    Spending with{" "}
                    <span className="text-muted-foreground">— optional</span>
                  </Label>
                  <Input
                    id={`spendingWith-${claim.id}`}
                    name="spendingWith"
                    placeholder="e.g. ABC Client Sdn Bhd, internal team"
                    defaultValue={claim.spendingWith ?? ""}
                    aria-invalid={errors?.spendingWith ? true : undefined}
                  />
                  {errors?.spendingWith ? (
                    <p className="text-xs text-destructive">
                      {errors.spendingWith}
                    </p>
                  ) : null}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor={`description-${claim.id}`}>
                    Business context{" "}
                    <span className="text-muted-foreground">— optional</span>
                  </Label>
                  <Textarea
                    id={`description-${claim.id}`}
                    name="description"
                    rows={3}
                    defaultValue={claim.description}
                    aria-invalid={errors?.description ? true : undefined}
                  />
                  {errors?.description ? (
                    <p className="text-xs text-destructive">
                      {errors.description}
                    </p>
                  ) : null}
                </div>

                <Button
                  type="submit"
                  size="sm"
                  disabled={updatePending}
                >
                  {updatePending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Saving…
                    </>
                  ) : (
                    "Save changes"
                  )}
                </Button>
              </form>
            ) : (
              <DetailGrid
                rows={[
                  { label: "Amount", value: `${formatCurrency(claim.amount)} ${claim.currency}` },
                  { label: "Spent on", value: formatShortDate(claim.spentAt) },
                  { label: "Submitted", value: formatShortDate(claim.submittedAt) },
                  claim.spendingAt
                    ? { label: "Spending at", value: claim.spendingAt }
                    : null,
                  claim.spendingWith
                    ? { label: "Spending with", value: claim.spendingWith }
                    : null,
                ]}
              />
            )}

            <Section title="Read-only details">
              <DetailGrid
                rows={[
                  {
                    label: "Account",
                    value: claim.chartOfAccount
                      ? `${claim.chartOfAccount.code} · ${claim.chartOfAccount.name}`
                      : "Not assigned",
                  },
                  {
                    label: "Payment",
                    value:
                      claim.paymentType === "COMPANY"
                        ? "Company money"
                        : "Personal money",
                  },
                  {
                    label: "Claims run",
                    value: claim.claimRunMonth
                      ? formatMonthYear(claim.claimRunMonth)
                      : "Not set",
                  },
                  { label: "Currency", value: claim.currency },
                ]}
              />
              <p className="text-[11px] text-muted-foreground">
                To change the account, payment method, or currency,
                delete this claim and submit a new one.
              </p>
            </Section>

            <Section title="Receipt">
              {claim.receiptUrl ? (
                <a
                  href={
                    replaceReceiptState.status === "success" &&
                    replaceReceiptState.receiptUrl
                      ? replaceReceiptState.receiptUrl
                      : claim.receiptUrl
                  }
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 text-sm font-semibold text-primary underline-offset-4 hover:underline"
                >
                  <Paperclip className="h-4 w-4" />
                  View receipt
                </a>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No primary receipt on file.
                </p>
              )}

              {editable ? (
                <form
                  action={replaceReceiptFormAction}
                  className="space-y-2 pt-2"
                >
                  <input type="hidden" name="claimId" value={claim.id} />
                  <input
                    ref={receiptInputRef}
                    type="file"
                    name="receiptFile"
                    accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
                    className="sr-only"
                    onChange={(e) => {
                      const next = e.target.files?.[0] ?? null
                      setPendingReceipt(next)
                    }}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => receiptInputRef.current?.click()}
                    >
                      <Paperclip className="mr-2 h-4 w-4" />
                      {claim.receiptUrl ? "Choose new receipt" : "Choose receipt"}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {pendingReceipt
                        ? pendingReceipt.name
                        : "JPG, PNG, WEBP, HEIC, or PDF up to 8 MB"}
                    </span>
                  </div>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={replaceReceiptPending || !pendingReceipt}
                  >
                    {replaceReceiptPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Uploading…
                      </>
                    ) : claim.receiptUrl ? (
                      "Replace receipt"
                    ) : (
                      "Upload receipt"
                    )}
                  </Button>
                  <p className="text-[11px] text-muted-foreground">
                    The previous receipt stays in storage for audit; only
                    the link on this claim is swapped.
                  </p>
                </form>
              ) : null}
            </Section>

            {supportingCount > 0 ? (
              <Section title={`Supporting documents (${supportingCount})`}>
                <ul className="space-y-1.5 text-sm">
                  {claim.supportingAttachments?.map((att) => (
                    <li key={att.id}>
                      {att.fileUrl ? (
                        <a
                          href={att.fileUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-2 text-primary underline-offset-4 hover:underline"
                        >
                          <Paperclip className="h-4 w-4" />
                          {att.fileName}
                        </a>
                      ) : (
                        <span className="inline-flex items-center gap-2 text-muted-foreground">
                          <Paperclip className="h-4 w-4" />
                          {att.fileName}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {claim.reviewNotes ? (
              <Section title="Reviewer note">
                <div className="rounded-2xl border border-border/70 bg-muted/40 p-3">
                  <p className="text-sm leading-6 text-muted-foreground">
                    {claim.reviewNotes}
                  </p>
                  {claim.reviewerName ? (
                    <p className="mt-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                      — {claim.reviewerName}
                    </p>
                  ) : null}
                </div>
              </Section>
            ) : null}

            {editable ? (
              <Section title="Attach more supporting documents">
                <form action={attachFormAction} className="space-y-3">
                  <input type="hidden" name="claimId" value={claim.id} />
                  <input
                    ref={attachInputRef}
                    type="file"
                    name="supportingFile"
                    multiple
                    accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.doc,.docx,.xls,.xlsx"
                    className="sr-only"
                    onChange={(e) => {
                      const next = Array.from(e.target.files ?? [])
                      setAttachFiles(next)
                    }}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => attachInputRef.current?.click()}
                    >
                      <Paperclip className="mr-2 h-4 w-4" />
                      Choose files
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {attachFiles.length === 0
                        ? "Up to 10 files, 8 MB each"
                        : `${attachFiles.length} file${attachFiles.length === 1 ? "" : "s"} ready to upload`}
                    </span>
                  </div>
                  {attachFiles.length > 0 ? (
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {attachFiles.map((f, i) => (
                        <li
                          key={`${f.name}-${i}`}
                          className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-2 py-1"
                        >
                          <span className="truncate">{f.name}</span>
                          <button
                            type="button"
                            onClick={() =>
                              setAttachFiles((prev) =>
                                prev.filter((_, idx) => idx !== i),
                              )
                            }
                            className="rounded p-1 hover:bg-muted"
                            aria-label={`Remove ${f.name}`}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <Button
                    type="submit"
                    size="sm"
                    disabled={attachPending || attachFiles.length === 0}
                  >
                    {attachPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Uploading…
                      </>
                    ) : (
                      "Attach"
                    )}
                  </Button>
                </form>
              </Section>
            ) : null}
          </div>

          <DialogFooter className="shrink-0 border-t border-border/60 pt-3">
            {editable ? (
              confirmDelete ? (
                <form
                  action={deleteFormAction}
                  className="flex w-full items-center justify-between gap-2"
                >
                  <input type="hidden" name="claimId" value={claim.id} />
                  <p className="text-sm text-muted-foreground">
                    This permanently removes the claim and its attachments.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setConfirmDelete(false)}
                      disabled={deletePending}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      variant="destructive"
                      disabled={deletePending}
                    >
                      {deletePending ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Deleting…
                        </>
                      ) : (
                        "Delete claim"
                      )}
                    </Button>
                  </div>
                </form>
              ) : (
                <>
                  <DialogClose asChild>
                    <Button type="button" variant="ghost">
                      Close
                    </Button>
                  </DialogClose>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete claim
                  </Button>
                </>
              )
            ) : (
              <DialogClose asChild>
                <Button type="button" variant="ghost">
                  Close
                </Button>
              </DialogClose>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function DetailGrid({
  rows,
}: {
  rows: Array<{ label: string; value: string } | null>
}) {
  const visible = rows.filter(
    (r): r is { label: string; value: string } => r !== null,
  )
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
      {visible.map((r) => (
        <div key={r.label} className="space-y-0.5">
          <dt className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            {r.label}
          </dt>
          <dd className="font-semibold text-foreground">{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  )
}
