"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { Camera, FileText, FileUp, Paperclip, Trash2 } from "lucide-react"

import { CameraCaptureModal } from "@/components/attendance/camera-capture-modal"

import { Badge } from "@/components/attendance/ui/badge"
import { Card, CardContent } from "@/components/attendance/ui/card"
import {
  approvalStatusMeta,
} from "@/modules/attendance/domain/metadata"
import type { ApprovalRequestView } from "@/modules/attendance/domain/models"
import {
  deleteOtAttachmentAction,
  uploadOtAttachmentAction,
} from "@/app/(employee)/employee/attendance/overtime-actions"

const APPROVAL_VARIANT: Record<string, string> = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
}

function fmtTime(iso: string | null, tz: string) {
  return iso
    ? new Date(iso).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: tz,
      })
    : "—"
}

function fmtUploadedAt(iso: string): string {
  return new Date(iso).toLocaleString("en-MY", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function fmtDuration(startIso: string, endIso: string): string {
  const diffMin = Math.round(
    (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000,
  )
  if (diffMin <= 0) return ""
  const h = Math.floor(diffMin / 60)
  const m = diffMin % 60
  if (h > 0 && m > 0) return `${h}h ${m}m`
  if (h > 0) return `${h}h`
  return `${m}m`
}

export function OtRecordCard({
  record,
  timezone,
}: {
  record: ApprovalRequestView
  timezone: string
}) {
  const [attachments, setAttachments] = useState(record.attachments)
  const [uploadPending, startUpload] = useTransition()
  const [deletePending, startDelete] = useTransition()
  const [evidencePickerOpen, setEvidencePickerOpen] = useState(false)
  const [cameraOpen, setCameraOpen] = useState(false)
  const evidencePickerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const canAttach = record.status === "PENDING" || record.status === "APPROVED"

  const justificationAttachments = attachments.filter((a) => a.kind === "JUSTIFICATION")
  const evidenceAttachments = attachments.filter((a) => a.kind === "EVIDENCE")

  useEffect(() => {
    if (!evidencePickerOpen) return
    function handleDown(e: MouseEvent) {
      if (evidencePickerRef.current && !evidencePickerRef.current.contains(e.target as Node)) {
        setEvidencePickerOpen(false)
      }
    }
    document.addEventListener("mousedown", handleDown)
    return () => document.removeEventListener("mousedown", handleDown)
  }, [evidencePickerOpen])

  function uploadFile(file: File) {
    const fd = new FormData()
    fd.set("file", file)
    startUpload(async () => {
      const res = await uploadOtAttachmentAction(record.id, fd)
      if ("error" in res) {
        alert(res.error)
      } else {
        setAttachments((prev) => [...prev, res.attachment])
      }
      if (fileInputRef.current) fileInputRef.current.value = ""
    })
  }

  function handleDelete(attachmentId: string) {
    startDelete(async () => {
      const res = await deleteOtAttachmentAction(attachmentId)
      if ("error" in res) {
        alert(res.error)
      } else {
        setAttachments((prev) => prev.filter((a) => a.id !== attachmentId))
      }
    })
  }

  const isPending = uploadPending || deletePending

  return (
    <>
    <Card>
      <CardContent className="p-4 space-y-3">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-foreground">{record.title}</p>
            <p className="text-xs text-muted-foreground">
              OT · {record.date}
              {record.project ? ` · ${record.project}` : ""}
            </p>
            {record.otStartAt && record.otEndAt ? (
              <p className="text-xs font-medium text-foreground mt-0.5">
                {fmtTime(record.otStartAt, timezone)} – {fmtTime(record.otEndAt, timezone)}
                <span className="ml-1.5 inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                  {fmtDuration(record.otStartAt, record.otEndAt)}
                </span>
              </p>
            ) : null}
            {record.detail ? (
              <p className="mt-1 text-xs text-muted-foreground">{record.detail}</p>
            ) : null}
            {record.reviewNotes ? (
              <p className="mt-1 text-xs italic text-muted-foreground">
                Reviewer: {record.reviewNotes}
              </p>
            ) : null}
          </div>
          <Badge variant={APPROVAL_VARIANT[record.status] as never}>
            {approvalStatusMeta[record.status].label}
          </Badge>
        </div>

        {/* Justification — always shown, read-only */}
        <div className="border-t border-border/50 pt-3 space-y-1.5">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <Paperclip className="h-3.5 w-3.5" />
            Before (Justification)
          </span>
          {justificationAttachments.length === 0 ? (
            <p className="text-xs text-muted-foreground">None uploaded.</p>
          ) : (
            <ul className="space-y-1.5">
              {justificationAttachments.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center gap-2 rounded-lg border border-border/50 bg-surface-low px-3 py-2"
                >
                  <a
                    href={a.fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-w-0 flex-1 items-center gap-2 text-xs font-medium text-foreground hover:underline"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <span className="truncate block">{a.fileName}</span>
                      {a.uploadedAt ? (
                        <span className="text-[10px] text-muted-foreground font-normal">
                          {fmtUploadedAt(a.uploadedAt)}
                        </span>
                      ) : null}
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Evidence — upload/delete only for pending/approved */}
        {canAttach ? (
          <div className="border-t border-border/50 pt-3 space-y-2">
            {/* Hidden file input (attach) */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
              className="sr-only"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f) }}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                <Paperclip className="h-3.5 w-3.5" />
                After (Evidence)
              </span>
              <div ref={evidencePickerRef} className="relative">
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => setEvidencePickerOpen((o) => !o)}
                  className="flex items-center gap-1 rounded-lg border border-border/60 bg-surface-low px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted/50 disabled:opacity-50"
                >
                  {uploadPending ? "Uploading…" : "Upload"}
                </button>
                {evidencePickerOpen && (
                  <div className="absolute right-0 top-[calc(100%+4px)] z-50 flex gap-2 rounded-xl border border-border bg-background p-2 shadow-lg">
                    <button
                      type="button"
                      onClick={() => { setEvidencePickerOpen(false); setCameraOpen(true) }}
                      className="flex flex-col items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-foreground hover:bg-muted"
                    >
                      <Camera className="h-4 w-4 text-muted-foreground" />
                      Take photo
                    </button>
                    <button
                      type="button"
                      onClick={() => { setEvidencePickerOpen(false); fileInputRef.current?.click() }}
                      className="flex flex-col items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-foreground hover:bg-muted"
                    >
                      <FileUp className="h-4 w-4 text-muted-foreground" />
                      Attach file
                    </button>
                  </div>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Upload photos or documents showing the work completed during this OT session.</p>

            {evidenceAttachments.length === 0 ? (
              <p className="text-xs text-muted-foreground">No evidence uploaded yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {evidenceAttachments.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-surface-low px-3 py-2"
                  >
                    <a
                      href={a.fileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex min-w-0 flex-1 items-center gap-2 text-xs font-medium text-foreground hover:underline"
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <span className="truncate block">{a.fileName}</span>
                        {a.uploadedAt ? (
                          <span className="text-[10px] text-muted-foreground font-normal">
                            {fmtUploadedAt(a.uploadedAt)}
                          </span>
                        ) : null}
                      </div>
                    </a>
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => handleDelete(a.id)}
                      className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive disabled:opacity-50"
                      aria-label="Delete attachment"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
    {cameraOpen && (
      <CameraCaptureModal
        onConfirm={(file) => { setCameraOpen(false); uploadFile(file) }}
        onCancel={() => setCameraOpen(false)}
      />
    )}
    </>
  )
}
