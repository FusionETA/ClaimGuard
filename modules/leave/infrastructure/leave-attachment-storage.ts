import "server-only"

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { getPrismaClient } from "@/lib/prisma"
import {
  getOrCreateLeaveAttachmentsFolder,
  uploadFileToXero,
} from "@/lib/xero"
import { getUsableXeroAccessToken } from "@/modules/organization/application/services/xero-connection.service"

/// Allowed attachment types for leave applications. JPEG/PNG/WEBP/HEIC
/// cover phone-camera shots of an MC slip; PDF covers clinic-issued slips.
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
])

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "application/pdf": ".pdf",
}

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024 // 10 MB

export type StoredAttachment = {
  /// URL the UI fetches. For Xero-backed files this is the proxy route;
  /// for local fallback it's the /uploads/... path Next.js serves.
  attachmentUrl: string
  attachmentName: string
  /// Xero file id when stored in Xero, null when stored locally.
  xeroFileId: string | null
}

/// Persist a leave attachment. Prefers Xero Files (mirrors how claim
/// receipts and attendance selfies are stored) and falls back to local
/// disk under public/uploads/leave-attachments/ when no usable Xero
/// connection exists for the employee's org or the upload fails.
///
/// Throws only on validation errors (wrong MIME, too big, empty).
/// Transient Xero issues fall back to local storage silently so the
/// employee's submission isn't blocked.
export async function storeLeaveAttachment(
  file: File,
  employeeProfileId: string,
): Promise<StoredAttachment> {
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    throw new Error("Upload a JPG, PNG, WEBP, HEIC, or PDF file.")
  }
  if (file.size <= 0) {
    throw new Error("Attachment is empty.")
  }
  if (file.size > MAX_ATTACHMENT_SIZE) {
    throw new Error("Attachment must be 10 MB or smaller.")
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const ext = EXT_BY_MIME[file.type] ?? path.extname(file.name) ?? ".bin"
  const safeName = file.name || `attachment${ext}`

  // Resolve a Xero connection for this employee's org. Profile preference
  // wins; otherwise fall back to the org's oldest connection. Mirrors the
  // selfie upload path.
  const connectionId = await resolveXeroConnectionId(employeeProfileId)

  if (connectionId) {
    try {
      const token = await getUsableXeroAccessToken(connectionId)
      if (!token) throw new Error("Xero connection unavailable.")

      const folderId = await getOrCreateLeaveAttachmentsFolder({
        accessToken: token.accessToken,
        tenantId: token.tenantId,
      })
      const uploaded = await uploadFileToXero({
        accessToken: token.accessToken,
        tenantId: token.tenantId,
        folderId,
        fileBuffer: buffer,
        fileName: safeName,
        mimeType: file.type,
      })
      return {
        attachmentUrl: `/api/leave/files/${uploaded.fileId}/content`,
        attachmentName: safeName,
        xeroFileId: uploaded.fileId,
      }
    } catch (err) {
      // Network/scope issue — degrade to local storage so the leave
      // application can still go through. Log so ops can investigate.
      console.error("[leave attachment] Xero upload failed, falling back to local disk", err)
    }
  }

  // Local fallback.
  const localUrl = await writeAttachmentLocally(buffer, file.type, safeName)
  return {
    attachmentUrl: localUrl,
    attachmentName: safeName,
    xeroFileId: null,
  }
}

async function resolveXeroConnectionId(employeeProfileId: string): Promise<string | null> {
  const prisma = getPrismaClient()
  if (!prisma) return null
  const profile = await prisma.employeeProfile.findFirst({
    where: { id: employeeProfileId },
    select: {
      user: { select: { organizationId: true } },
    },
  })
  if (!profile?.user.organizationId) return null
  const conn = await prisma.xeroConnection.findFirst({
    where: { organizationId: profile.user.organizationId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  })
  return conn?.id ?? null
}

async function writeAttachmentLocally(
  buffer: Buffer,
  mimeType: string,
  originalName: string,
): Promise<string> {
  const ext = EXT_BY_MIME[mimeType] ?? path.extname(originalName) ?? ".bin"
  const filename = `${Date.now()}-${crypto.randomUUID()}${ext}`
  const dir = path.join(process.cwd(), "public", "uploads", "leave-attachments")
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, filename), buffer)
  return `/uploads/leave-attachments/${filename}`
}
