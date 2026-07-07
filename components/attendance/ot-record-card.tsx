"use client"

import { useRef, useTransition } from "react"
import { FileText, Paperclip, Trash2, Upload } from "lucide-react"

import { Badge } from "@/components/attendance/ui/badge"
import { Card, CardContent } from "@/components/attendance/ui/card"
import {
  approvalStatusMeta,
  otSubtypeMeta,
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
  const [uploadPending, startUpload] = useTransition()
  const [deletePending, startDelete] = useTransition()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const canAttach = record.status === "PENDING" || record.status === "APPROVED"

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const fd = new FormData()
    fd.set("file", file)
    startUpload(async () => {
      const res = await uploadOtAttachmentAction(record.id, fd)
      if ("error" in res) alert(res.error)
      // reset input so the same file can be re-uploaded if needed
      if (fileInputRef.current) fileInputRef.current.value = ""
    })
  }

  function handleDelete(attachmentId: string) {
    startDelete(async () => {
      const res = await deleteOtAttachmentAction(attachmentId)
      if ("error" in res) alert(res.error)
    })
  }

  const isPending = uploadPending || deletePending

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-foreground">{record.title}</p>
            <p className="text-xs text-muted-foreground">
              {record.otSubtype ? otSubtypeMeta[record.otSubtype].label : "OT"} · {record.date}
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

        {/* Attachments section — only for pending/approved */}
        {canAttach ? (
          <div className="border-t border-border/50 pt-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                <Paperclip className="h-3.5 w-3.5" />
                Evidence
              </span>
              <button
                type="button"
                disabled={isPending}
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1 rounded-lg border border-border/60 bg-surface-low px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted/50 disabled:opacity-50"
              >
                <Upload className="h-3 w-3" />
                {uploadPending ? "Uploading…" : "Upload"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>

            {record.attachments.length === 0 ? (
              <p className="text-xs text-muted-foreground">No evidence uploaded yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {record.attachments.map((a) => (
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
                      <span className="truncate">{a.fileName}</span>
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
  )
}
