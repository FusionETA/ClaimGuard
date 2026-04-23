"use server"

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { revalidatePath } from "next/cache"

import { getCurrentSession } from "@/lib/auth/session"
import {
  createClaimForEmployee,
  createClaimSchema,
} from "@/modules/claims/application/services/claim-workflow.service"
import type { ClaimFormState, ClaimFormValues } from "@/app/(employee)/employee/claims/new/form-state"
import { initialClaimFormState } from "@/app/(employee)/employee/claims/new/form-state"

const MAX_RECEIPT_SIZE = 8 * 1024 * 1024
const allowedReceiptTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
])

function getReceiptExtension(file: File) {
  const typeExtensionMap: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
  }

  const mappedExtension = typeExtensionMap[file.type]
  if (mappedExtension) return mappedExtension

  const originalExtension = path.extname(file.name)
  return originalExtension || ".jpg"
}

export async function submitClaimAction(
  _previousState: ClaimFormState,
  formData: FormData
): Promise<ClaimFormState> {
  const receiptFile = formData.get("receiptFile")

  const values: ClaimFormValues = {
    title: String(formData.get("title") ?? ""),
    category: String(formData.get("category") ?? "TRAVEL") as ClaimFormValues["category"],
    amount: String(formData.get("amount") ?? ""),
    spentAt: String(formData.get("spentAt") ?? ""),
    description: String(formData.get("description") ?? ""),
    receiptUrl: String(formData.get("receiptUrl") ?? ""),
  }

  // Validate form fields.
  const parsed = createClaimSchema.safeParse(values)
  const receiptError =
    receiptFile instanceof File && receiptFile.size > 0
      ? !allowedReceiptTypes.has(receiptFile.type)
        ? "Upload a JPG, PNG, WEBP, or HEIC receipt photo."
        : receiptFile.size > MAX_RECEIPT_SIZE
          ? "Receipt photo must be 8 MB or smaller."
          : undefined
      : undefined

  if (!parsed.success || receiptError) {
    const fieldErrors = parsed.success ? {} : parsed.error.flatten().fieldErrors
    return {
      status: "error",
      message: "Please review the highlighted fields and try again.",
      values,
      errors: {
        title: fieldErrors.title?.[0],
        category: fieldErrors.category?.[0],
        amount: fieldErrors.amount?.[0],
        spentAt: fieldErrors.spentAt?.[0],
        description: fieldErrors.description?.[0],
        receiptUrl: receiptError ?? fieldErrors.receiptUrl?.[0],
      },
    }
  }

  // Get the logged-in employee's session.
  const session = await getCurrentSession()
  if (!session || (session.role !== "EMPLOYEE" && session.role !== "SUPERVISOR")) {
    return {
      status: "error",
      message: "Session expired. Please log in again.",
      values,
      errors: {},
    }
  }

  let receiptUrl: string | undefined

  if (receiptFile instanceof File && receiptFile.size > 0) {
    try {
      const receiptBuffer = Buffer.from(await receiptFile.arrayBuffer())
      const uploadsDirectory = path.join(process.cwd(), "public", "uploads", "receipts")
      const filename = `${Date.now()}-${crypto.randomUUID()}${getReceiptExtension(receiptFile)}`

      await mkdir(uploadsDirectory, { recursive: true })
      await writeFile(path.join(uploadsDirectory, filename), receiptBuffer)

      receiptUrl = `/uploads/receipts/${filename}`
    } catch {
      return {
        status: "error",
        message: "We couldn't save the receipt photo. Please try again.",
        values,
        errors: {
          receiptUrl: "Receipt upload failed. Please try again.",
        },
      }
    }
  }

  const result = await createClaimForEmployee({
    session,
    input: {
      title: parsed.data.title,
      category: parsed.data.category,
      amount: parsed.data.amount,
      spentAt: parsed.data.spentAt,
      description: parsed.data.description,
      receiptUrl,
    },
  })

  if (!result.ok) {
    return {
      status: "error",
      message: result.message,
      values,
      errors: result.fieldErrors ?? {},
    }
  }

  // Bust Next.js page cache.
  revalidatePath("/employee")
  revalidatePath("/employee/claims")
  revalidatePath("/admin")
  revalidatePath("/admin/claims")

  return {
    status: "success",
    message: "Claim submitted successfully.",
    values: initialClaimFormState.values,
    errors: {},
  }
}
