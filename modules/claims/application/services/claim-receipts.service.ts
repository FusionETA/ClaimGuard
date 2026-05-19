import "server-only"

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import {
  getOrCreateClaimsFolder,
  uploadFileToXero,
} from "@/lib/xero"
import { getUsableXeroAccessToken } from "@/modules/organization/application/services/xero-connection.service"

/**
 * Receipt upload pipeline. Decides between two storage backends based on
 * whether the chart-of-account is connected to a Xero tenant:
 *
 *   - **Xero Files** when a usable Xero connection exists for the COA.
 *     The receipt uploads into the tenant's "Claims" folder. The claim
 *     row stores the resulting Xero file id, and the receipt URL the UI
 *     consumes is the proxy route `/api/xero/files/{fileId}/content` so
 *     the bearer token never reaches the browser.
 *
 *   - **Local disk** when the COA is custom (no xeroConnectionId). The
 *     receipt is written under `public/uploads/receipts/`, same as the
 *     pre-Xero-Files flow. `xeroFileId` stays null.
 *
 * If a Xero upload throws (network blip, expired refresh token, missing
 * `files` scope) the function falls back to local storage so the
 * employee's submission isn't blocked. The claim is saved with no
 * xeroFileId and a warning the action can surface to the user.
 */
export type StoredReceipt = {
  /** URL the UI should fetch when displaying the receipt. */
  receiptUrl: string
  /** Xero file id, or null when stored locally. */
  xeroFileId: string | null
  /** Optional non-fatal warning message (e.g. Xero upload fell back to local). */
  warning?: string
}

const MAX_RECEIPT_SIZE = 8 * 1024 * 1024
const allowedMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
])

function getReceiptExtension(file: File): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
  }
  const ext = map[file.type]
  if (ext) return ext
  return path.extname(file.name) || ".jpg"
}

function generateLocalFilename(originalName: string, mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
  }
  const fallbackExt = map[mimeType] ?? (path.extname(originalName) || ".jpg")
  return `${Date.now()}-${crypto.randomUUID()}${fallbackExt}`
}

/**
 * Store a receipt and return the URL + (optional) Xero file id. Throws
 * only on validation errors (oversized, wrong MIME); transient Xero
 * issues fall back to local storage and return a warning.
 */
export async function storeReceiptForClaim(input: {
  receiptFile: File
  /** Xero connection id from the chart-of-account. Null/undefined means
   *  custom account → store locally. */
  xeroConnectionId: string | null | undefined
}): Promise<StoredReceipt> {
  const file = input.receiptFile

  if (!allowedMimeTypes.has(file.type)) {
    throw new Error("Upload a JPG, PNG, WEBP, or HEIC receipt photo.")
  }
  if (file.size <= 0) {
    throw new Error("Receipt file is empty.")
  }
  if (file.size > MAX_RECEIPT_SIZE) {
    throw new Error("Receipt photo must be 8 MB or smaller.")
  }

  const buffer = Buffer.from(await file.arrayBuffer())

  // Branch by Xero availability.
  if (input.xeroConnectionId) {
    try {
      const token = await getUsableXeroAccessToken(input.xeroConnectionId)
      if (!token) throw new Error("Xero connection unavailable.")

      const folderId = await getOrCreateClaimsFolder({
        accessToken: token.accessToken,
        tenantId: token.tenantId,
      })

      const uploaded = await uploadFileToXero({
        accessToken: token.accessToken,
        tenantId: token.tenantId,
        folderId,
        fileBuffer: buffer,
        fileName: file.name || `receipt${getReceiptExtension(file)}`,
        mimeType: file.type,
      })

      return {
        receiptUrl: `/api/xero/files/${uploaded.fileId}/content`,
        xeroFileId: uploaded.fileId,
      }
    } catch (error) {
      // Xero upload failed — degrade gracefully. Save locally so the
      // claim still goes through; admin can spot the missing xeroFileId
      // and re-upload manually if needed.
      const message = error instanceof Error ? error.message : String(error)
      const local = await writeReceiptLocally(buffer, file)
      return {
        receiptUrl: local,
        xeroFileId: null,
        warning: `Receipt saved locally — Xero Files upload failed: ${message}`,
      }
    }
  }

  // Custom-account claim. Local disk only.
  const local = await writeReceiptLocally(buffer, file)
  return { receiptUrl: local, xeroFileId: null }
}

async function writeReceiptLocally(buffer: Buffer, file: File): Promise<string> {
  const uploadsDir = path.join(process.cwd(), "public", "uploads", "receipts")
  const filename = generateLocalFilename(file.name, file.type)
  await mkdir(uploadsDir, { recursive: true })
  await writeFile(path.join(uploadsDir, filename), buffer)
  return `/uploads/receipts/${filename}`
}

// ─── Supporting attachments (extras alongside the primary receipt) ─────

/**
 * Wider MIME allowlist for supporting documents. Beyond receipt-style
 * images, accept PDFs (quotations, invoices) and common office /
 * document formats. Same per-file size cap as receipts.
 */
const allowedSupportingMimeTypes = new Set([
  // Images
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  // Documents
  "application/pdf",
  // Office variants — some browsers report these for .docx / .xlsx /
  // .csv files. We accept them so admins can attach exports.
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/plain",
])

const MAX_SUPPORTING_SIZE = 8 * 1024 * 1024 // 8 MB — matches receipt cap

function getSupportingExtension(file: File): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
    "application/pdf": ".pdf",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      ".xlsx",
    "text/csv": ".csv",
    "text/plain": ".txt",
  }
  return map[file.type] ?? path.extname(file.name) ?? ".bin"
}

/**
 * Store a supporting document. Same storage decision tree as the
 * primary receipt (Xero Files when the COA is Xero-linked; local
 * disk otherwise), but with a wider MIME allowlist.
 */
export async function storeSupportingFileForClaim(input: {
  file: File
  xeroConnectionId: string | null | undefined
}): Promise<{
  fileName: string
  fileUrl: string | null
  xeroFileId: string | null
  mimeType: string
  sizeBytes: number
  warning?: string
}> {
  const file = input.file
  if (!allowedSupportingMimeTypes.has(file.type)) {
    throw new Error(
      "Supporting document must be a JPG, PNG, WEBP, HEIC, PDF, or Office file.",
    )
  }
  if (file.size <= 0) throw new Error("Supporting file is empty.")
  if (file.size > MAX_SUPPORTING_SIZE) {
    throw new Error("Each supporting file must be 8 MB or smaller.")
  }
  const buffer = Buffer.from(await file.arrayBuffer())

  if (input.xeroConnectionId) {
    try {
      const token = await getUsableXeroAccessToken(input.xeroConnectionId)
      if (!token) throw new Error("Xero connection unavailable.")
      const folderId = await getOrCreateClaimsFolder({
        accessToken: token.accessToken,
        tenantId: token.tenantId,
      })
      const uploaded = await uploadFileToXero({
        accessToken: token.accessToken,
        tenantId: token.tenantId,
        folderId,
        fileBuffer: buffer,
        fileName: file.name || `supporting${getSupportingExtension(file)}`,
        mimeType: file.type,
      })
      return {
        fileName: file.name || `supporting${getSupportingExtension(file)}`,
        fileUrl: `/api/xero/files/${uploaded.fileId}/content`,
        xeroFileId: uploaded.fileId,
        mimeType: file.type,
        sizeBytes: file.size,
      }
    } catch (error) {
      // Fall back to local — claim still goes through.
      const message = error instanceof Error ? error.message : String(error)
      const local = await writeSupportingLocally(buffer, file)
      return {
        fileName: file.name || `supporting${getSupportingExtension(file)}`,
        fileUrl: local,
        xeroFileId: null,
        mimeType: file.type,
        sizeBytes: file.size,
        warning: `Saved locally — Xero Files upload failed: ${message}`,
      }
    }
  }

  const local = await writeSupportingLocally(buffer, file)
  return {
    fileName: file.name || `supporting${getSupportingExtension(file)}`,
    fileUrl: local,
    xeroFileId: null,
    mimeType: file.type,
    sizeBytes: file.size,
  }
}

async function writeSupportingLocally(
  buffer: Buffer,
  file: File,
): Promise<string> {
  const uploadsDir = path.join(
    process.cwd(),
    "public",
    "uploads",
    "claim-supporting",
  )
  const ext = getSupportingExtension(file)
  const filename = `${Date.now()}-${crypto.randomUUID()}${ext}`
  await mkdir(uploadsDir, { recursive: true })
  await writeFile(path.join(uploadsDir, filename), buffer)
  return `/uploads/claim-supporting/${filename}`
}
