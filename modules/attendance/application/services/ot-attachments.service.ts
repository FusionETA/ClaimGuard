import "server-only"

import { writeFile, unlink } from "fs/promises"
import { join } from "path"
import { randomUUID } from "crypto"

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
])

const MAX_SIZE_BYTES = 8 * 1024 * 1024

export type StoredOtAttachment = {
  fileName: string
  fileUrl: string
  mimeType: string
  sizeBytes: number
}

export async function storeOtAttachment(file: File): Promise<StoredOtAttachment> {
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    throw new Error("Only JPG, PNG, WEBP, HEIC, and PDF files are allowed.")
  }
  if (file.size > MAX_SIZE_BYTES) {
    throw new Error("File must be 8 MB or smaller.")
  }

  const ext = file.name.split(".").pop() ?? "bin"
  const safeName = `${randomUUID()}.${ext}`
  const dir = join(process.cwd(), "public", "uploads", "ot-attachments")
  const filePath = join(dir, safeName)

  const { mkdir } = await import("fs/promises")
  await mkdir(dir, { recursive: true })

  const bytes = await file.arrayBuffer()
  await writeFile(filePath, Buffer.from(bytes))

  return {
    fileName: file.name,
    fileUrl: `/uploads/ot-attachments/${safeName}`,
    mimeType: file.type,
    sizeBytes: file.size,
  }
}

export async function deleteOtAttachmentFile(fileUrl: string): Promise<void> {
  try {
    const relativePath = fileUrl.replace(/^\//, "")
    const fullPath = join(process.cwd(), "public", relativePath)
    await unlink(fullPath)
  } catch {
    // File may already be gone — not fatal
  }
}
