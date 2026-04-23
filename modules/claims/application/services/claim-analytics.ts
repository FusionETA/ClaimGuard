import type {
  ClaimRecord,
  PortalUser,
} from "@/modules/claims/domain/models"

export function buildEmployeeDashboard(employee: PortalUser, claims: ClaimRecord[]) {
  const paidTotal = claims
    .filter((claim) => claim.status === "PAID" || claim.status === "APPROVED")
    .reduce((sum, claim) => sum + claim.amount, 0)

  return {
    employee,
    totals: {
      reimbursed: paidTotal,
      pending: claims.filter((claim) => claim.status === "PENDING" || claim.status === "SUBMITTED")
        .length,
      approved: claims.filter((claim) => claim.status === "APPROVED").length,
      paid: claims.filter((claim) => claim.status === "PAID").length,
    },
    recentClaims: [...claims].sort((a, b) => {
      return new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
    }),
  }
}

export function buildMonthlyVolumes(claims: ClaimRecord[]) {
  const monthlyTotals = new Map<string, number>()

  for (const claim of claims) {
    const key = claim.submittedAt.slice(0, 7)
    monthlyTotals.set(key, (monthlyTotals.get(key) ?? 0) + 1)
  }

  return [...monthlyTotals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-6)
    .map(([month, total]) => ({
      month: `${month}-01`,
      total,
    }))
}

export function buildAdminOverview(claims: ClaimRecord[]) {
  return {
    totals: {
      totalClaims: claims.length,
      pending: claims.filter((claim) => claim.status === "PENDING" || claim.status === "SUBMITTED")
        .length,
      approvedValue: claims
        .filter((claim) => claim.status === "APPROVED" || claim.status === "PAID")
        .reduce((sum, claim) => sum + claim.amount, 0),
      paidValue: claims
        .filter((claim) => claim.status === "PAID")
        .reduce((sum, claim) => sum + claim.amount, 0),
    },
    alerts: {
      highValue: claims.filter((claim) => claim.amount >= 1000).length,
      readyForPayout: claims.filter((claim) => claim.status === "APPROVED").length,
      autoReviewScore: 88,
    },
    monthlyVolume: buildMonthlyVolumes(claims),
    queue: [...claims].sort((a, b) => {
      return new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
    }),
  }
}


