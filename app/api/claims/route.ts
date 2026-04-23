import { NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { getCurrentSession } from "@/lib/auth/session"
import {
  createClaimForEmployee,
  listClaimsForSession,
} from "@/modules/claims/application/services/claim-workflow.service"
import { claimStatuses } from "@/modules/claims/domain/models"

const claimsQuerySchema = z.object({
  status: z.enum(["ALL", ...claimStatuses]).optional(),
})

export async function GET(request: Request) {
  const session = await getCurrentSession()

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const url = new URL(request.url)
  const parsed = claimsQuerySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
  })

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid query.",
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 400 }
    )
  }

  const claims = await listClaimsForSession({
    session,
    status: parsed.data.status,
  })

  return NextResponse.json({ claims })
}

export async function POST(request: Request) {
  const session = await getCurrentSession()

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await request.json().catch(() => null)

  const result = await createClaimForEmployee({
    session,
    input: {
      title: String(body?.title ?? ""),
      category: String(body?.category ?? "TRAVEL"),
      amount: body?.amount ?? "",
      spentAt: String(body?.spentAt ?? ""),
      description: String(body?.description ?? ""),
      receiptUrl: body?.receiptUrl ? String(body.receiptUrl) : undefined,
    },
  })

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.message,
        values: result.values,
        fieldErrors: result.fieldErrors,
      },
      { status: result.status }
    )
  }

  revalidatePath("/employee")
  revalidatePath("/employee/claims")
  revalidatePath("/admin")
  revalidatePath("/admin/claims")

  return NextResponse.json({ ok: true }, { status: 201 })
}
