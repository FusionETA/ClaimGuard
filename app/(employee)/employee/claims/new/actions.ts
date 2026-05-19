"use server"

import { revalidatePath } from "next/cache"

import { getCurrentSession } from "@/lib/auth/session"
import { bustClaimCaches } from "@/lib/cache-invalidation"
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

export async function submitClaimAction(
  _previousState: ClaimFormState,
  formData: FormData
): Promise<ClaimFormState> {
  const receiptFile = formData.get("receiptFile")
  // Supporting docs come in as multiple files under the `supportingFile`
  // key. `getAll` returns FormDataEntryValue[] (FILE | STRING); we
  // narrow to actual non-empty File instances here.
  const supportingFiles = formData
    .getAll("supportingFile")
    .filter(
      (entry): entry is File =>
        entry instanceof File && entry.size > 0 && entry.name !== "",
    )

  const rawPaymentType = String(formData.get("paymentType") ?? "PERSONAL")
  const paymentType: "PERSONAL" | "COMPANY" =
    rawPaymentType === "COMPANY" ? "COMPANY" : "PERSONAL"

  const rawClaimType = String(formData.get("claimType") ?? "EXPENSE")
  const claimType: "EXPENSE" | "MILEAGE" =
    rawClaimType === "MILEAGE" ? "MILEAGE" : "EXPENSE"

  const values: ClaimFormValues = {
    title: String(formData.get("title") ?? ""),
    chartOfAccountId: String(formData.get("chartOfAccountId") ?? ""),
    amount: String(formData.get("amount") ?? ""),
    spentAt: String(formData.get("spentAt") ?? ""),
    description: String(formData.get("description") ?? ""),
    receiptUrl: String(formData.get("receiptUrl") ?? ""),
    currency: String(formData.get("currency") ?? ""),
    paymentType,
    payViaAccountId: String(formData.get("payViaAccountId") ?? ""),
    projectId: String(formData.get("projectId") ?? ""),
    claimType,
    distance: String(formData.get("distance") ?? ""),
    mileageOriginAddress: String(formData.get("mileageOriginAddress") ?? ""),
    mileageDestinationAddress: String(
      formData.get("mileageDestinationAddress") ?? ""
    ),
    spendingWith: String(formData.get("spendingWith") ?? ""),
  }

  // Build the payload Zod will see — for mileage, omit `amount` so the
  // discriminated union goes to the right branch.
  const candidate =
    claimType === "MILEAGE"
      ? {
          claimType,
          title: values.title,
          chartOfAccountId: values.chartOfAccountId,
          spentAt: values.spentAt,
          description: values.description,
          receiptUrl: values.receiptUrl || undefined,
          currency: values.currency || undefined,
          paymentType: values.paymentType,
          payViaAccountId: values.payViaAccountId || undefined,
          projectId: values.projectId || undefined,
          spendingWith: values.spendingWith || undefined,
          distance: values.distance,
          mileageOriginAddress: values.mileageOriginAddress,
          mileageDestinationAddress: values.mileageDestinationAddress,
        }
      : {
          claimType,
          title: values.title,
          chartOfAccountId: values.chartOfAccountId,
          amount: values.amount,
          spentAt: values.spentAt,
          description: values.description,
          receiptUrl: values.receiptUrl || undefined,
          currency: values.currency || undefined,
          paymentType: values.paymentType,
          payViaAccountId: values.payViaAccountId || undefined,
          projectId: values.projectId || undefined,
          spendingWith: values.spendingWith || undefined,
        }

  // Validate form fields.
  const parsed = createClaimSchema.safeParse(candidate)
  const receiptError =
    receiptFile instanceof File && receiptFile.size > 0
      ? !allowedReceiptTypes.has(receiptFile.type)
        ? "Upload a JPG, PNG, WEBP, or HEIC receipt photo."
        : receiptFile.size > MAX_RECEIPT_SIZE
          ? "Receipt photo must be 8 MB or smaller."
          : undefined
      : undefined

  if (!parsed.success || receiptError) {
    const fieldErrors = parsed.success
      ? ({} as Record<string, string[] | undefined>)
      : (parsed.error.flatten().fieldErrors as Record<string, string[] | undefined>)
    return {
      status: "error",
      message: "Please review the highlighted fields and try again.",
      values,
      errors: {
        title: fieldErrors.title?.[0],
        chartOfAccountId: fieldErrors.chartOfAccountId?.[0],
        amount: fieldErrors.amount?.[0],
        spentAt: fieldErrors.spentAt?.[0],
        description: fieldErrors.description?.[0],
        receiptUrl: receiptError ?? fieldErrors.receiptUrl?.[0],
        paymentType: fieldErrors.paymentType?.[0],
        payViaAccountId: fieldErrors.payViaAccountId?.[0],
        projectId: fieldErrors.projectId?.[0],
        claimType: fieldErrors.claimType?.[0],
        distance: fieldErrors.distance?.[0],
        mileageOriginAddress: fieldErrors.mileageOriginAddress?.[0],
        mileageDestinationAddress: fieldErrors.mileageDestinationAddress?.[0],
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

  // Pass the receipt File straight to the workflow service. The service
  // is the only layer that knows whether the chart-of-account has a Xero
  // connection — that determines whether the receipt goes to Xero Files
  // or local disk. Empty / no file is fine; the service treats it as
  // "no receipt".
  const receiptFileToStore =
    receiptFile instanceof File && receiptFile.size > 0 ? receiptFile : undefined

  const result = await createClaimForEmployee({
    session,
    input:
      parsed.data.claimType === "MILEAGE"
        ? {
            title: parsed.data.title,
            chartOfAccountId: parsed.data.chartOfAccountId,
            spentAt: parsed.data.spentAt,
            description: parsed.data.description,
            receiptFile: receiptFileToStore,
            supportingFiles,
            paymentType: parsed.data.paymentType,
            payViaAccountId: parsed.data.payViaAccountId,
            projectId: parsed.data.projectId,
            spendingWith: parsed.data.spendingWith,
            claimType: "MILEAGE",
            distance: parsed.data.distance,
            mileageOriginAddress: parsed.data.mileageOriginAddress,
            mileageDestinationAddress: parsed.data.mileageDestinationAddress,
          }
        : {
            title: parsed.data.title,
            chartOfAccountId: parsed.data.chartOfAccountId,
            amount: parsed.data.amount,
            spentAt: parsed.data.spentAt,
            description: parsed.data.description,
            receiptFile: receiptFileToStore,
            supportingFiles,
            paymentType: parsed.data.paymentType,
            payViaAccountId: parsed.data.payViaAccountId,
            projectId: parsed.data.projectId,
            spendingWith: parsed.data.spendingWith,
            claimType: "EXPENSE",
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

  // Bust Redis claim caches for this org. Scope to this user since the
  // submission only affects their per-user history; the admin queue
  // pattern (org:{id}:claims:*) is also covered by the helper.
  if (session.organizationId) {
    await bustClaimCaches({
      organizationId: session.organizationId,
      userId: session.userId,
    })
  }

  return {
    status: "success",
    // When the claim exceeded the spend limit, the workflow returns a
    // warning string we surface here so the toast says "submitted, but
    // flagged" instead of "submitted successfully". The claim still goes
    // through normal approval.
    message: result.warning ?? "Claim submitted successfully.",
    values: initialClaimFormState.values,
    errors: {},
  }
}
