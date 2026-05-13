import "server-only"

import crypto from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import { getPrismaClient } from "@/lib/prisma"
import type { PayrollDocument } from "@/modules/payroll/domain/models"
import { payrollProfileRepository } from "@/modules/payroll/infrastructure/payroll-profile.repository"

/**
 * Upload + delete handlers for the per-employee documents card on the
 * payroll detail page. Documents are HR artefacts (contracts, offer
 * letters, NDA scans, ID copies, etc.) attached to a single employee.
 *
 * Storage: local disk under `public/uploads/payroll-documents/{userId}/`.
 * Metadata is stored as a JSON array on `PayrollProfile.payrollDocuments`.
 * No Xero Files integration in v1 — these aren't accounting receipts.
 */

const MAX_DOCUMENT_SIZE = 10 * 1024 * 1024 // 10 MB per file
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
])

export async function uploadPayrollDocument(input: {
  userId: string
  file: File
}): Promise<PayrollDocument[]> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Database is not configured.")

  // Verify the employee belongs to this admin's org.
  const employee = await prisma.user.findFirst({
    where: { id: input.userId, organizationId: orgId },
    select: {
      employeeProfile: {
        select: {
          id: true,
          payrollProfile: { select: { id: true, payrollDocuments: true } },
        },
      },
    },
  })
  if (!employee?.employeeProfile) {
    throw new Error("Employee not found in this organisation.")
  }
  const employeeProfileId = employee.employeeProfile.id

  const file = input.file
  if (!file || file.size <= 0) {
    throw new Error("File is empty.")
  }
  if (file.size > MAX_DOCUMENT_SIZE) {
    throw new Error("File too large (max 10 MB per document).")
  }
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    throw new Error(
      "Allowed formats: PDF, Word (.doc/.docx), JPG, PNG, WEBP, HEIC.",
    )
  }

  // Persist file to disk.
  const buffer = Buffer.from(await file.arrayBuffer())
  const uploadsDir = path.join(
    process.cwd(),
    "public",
    "uploads",
    "payroll-documents",
    input.userId,
  )
  await mkdir(uploadsDir, { recursive: true })

  const ext =
    path.extname(file.name).toLowerCase() ||
    mimeToExtension(file.type) ||
    ".bin"
  const storedFilename = `${Date.now()}-${crypto.randomUUID()}${ext}`
  await writeFile(path.join(uploadsDir, storedFilename), buffer)

  const doc: PayrollDocument = {
    id: crypto.randomUUID(),
    name: file.name || `document${ext}`,
    mimeType: file.type,
    sizeBytes: file.size,
    url: `/uploads/payroll-documents/${input.userId}/${storedFilename}`,
    uploadedAt: new Date().toISOString(),
  }

  // Append to the JSON column. We round-trip through the repo so the
  // parser normalises any legacy entries on the way in.
  const existing = await payrollProfileRepository.getByEmployeeProfileId(
    employeeProfileId,
  )
  const next = [...(existing?.payrollDocuments ?? []), doc]
  await payrollProfileRepository.upsert({
    employeeProfileId,
    patch: { payrollDocuments: next },
  })

  // Bust the org cache so the page reflects the new doc.
  await bustOrgConfigCaches({ organizationId: orgId })

  return next
}

export async function deletePayrollDocument(input: {
  userId: string
  documentId: string
}): Promise<PayrollDocument[]> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Database is not configured.")

  const employee = await prisma.user.findFirst({
    where: { id: input.userId, organizationId: orgId },
    select: { employeeProfile: { select: { id: true } } },
  })
  if (!employee?.employeeProfile) {
    throw new Error("Employee not found in this organisation.")
  }
  const employeeProfileId = employee.employeeProfile.id

  const existing = await payrollProfileRepository.getByEmployeeProfileId(
    employeeProfileId,
  )
  const next = (existing?.payrollDocuments ?? []).filter(
    (d) => d.id !== input.documentId,
  )

  await payrollProfileRepository.upsert({
    employeeProfileId,
    patch: { payrollDocuments: next },
  })

  // Note: we intentionally don't delete the physical file from disk.
  // Keeps an audit trail in case the admin re-attaches the same doc,
  // and avoids race conditions if the URL is still cached anywhere.

  await bustOrgConfigCaches({ organizationId: orgId })

  return next
}

function mimeToExtension(mime: string): string | null {
  switch (mime) {
    case "application/pdf":
      return ".pdf"
    case "application/msword":
      return ".doc"
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return ".docx"
    case "image/jpeg":
      return ".jpg"
    case "image/png":
      return ".png"
    case "image/webp":
      return ".webp"
    case "image/heic":
      return ".heic"
    case "image/heif":
      return ".heif"
    default:
      return null
  }
}
