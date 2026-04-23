import { revalidatePath } from "next/cache"
import { NextResponse } from "next/server"

import { getCurrentSession } from "@/lib/auth/session"
import { reviewClaimForSupervisor } from "@/modules/claims/application/services/claim-workflow.service"

type RouteContext = {
  params: Promise<{
    claimId: string
  }>
}

export async function POST(request: Request, context: RouteContext) {
  const session = await getCurrentSession()

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { claimId } = await context.params
  const body = await request.json().catch(() => null)

  const result = await reviewClaimForSupervisor({
    session,
    input: {
      claimId,
      decision: String(body?.decision ?? "APPROVED"),
      reason: String(body?.reason ?? ""),
    },
  })

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.message,
        fieldErrors: result.fieldErrors,
      },
      { status: result.status }
    )
  }

  revalidatePath("/admin")
  revalidatePath("/admin/claims")
  revalidatePath("/employee")
  revalidatePath("/employee/claims")

  return NextResponse.json({
    claimStatus: result.claimStatus,
    reviewerName: result.reviewerName,
    reason: result.reason,
  })
}
