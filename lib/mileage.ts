import type {
  ChartOfAccountOption,
  MileageUnit,
  OrganizationSummary,
} from "@/modules/organization/domain/models"

/**
 * Pure mileage amount calculator. Rounded to 2 decimals to match the
 * `Decimal(10, 2)` precision of `Claim.amount` in the database.
 *
 * Lives outside the service module (which is `import "server-only"`) so the
 * client claim form can preview the same number that the server will compute.
 */
export function computeMileageAmount(input: {
  distance: number
  rate: number
}): number {
  const raw = input.distance * input.rate
  return Math.round(raw * 100) / 100
}

/**
 * Pick the mileage rate for a given account: per-account override beats org
 * default. Returns null if neither is configured.
 */
export function resolveMileageRate(input: {
  organization: OrganizationSummary
  account: ChartOfAccountOption
}): { rate: number; unit: MileageUnit } | null {
  const accountRate = input.account.mileageRate
  if (accountRate != null && accountRate > 0) {
    return { rate: accountRate, unit: input.organization.mileageUnit }
  }
  const orgRate = input.organization.defaultMileageRate
  if (orgRate != null && orgRate > 0) {
    return { rate: orgRate, unit: input.organization.mileageUnit }
  }
  return null
}
