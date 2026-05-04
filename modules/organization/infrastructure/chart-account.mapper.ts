import { toNumber } from "@/lib/decimal"
import type {
  ChartOfAccountOption,
  LimitPeriod,
  LimitScope,
} from "@/modules/organization/domain/models"

/**
 * Single source of truth for the Prisma `ChartOfAccount` row → domain
 * `ChartOfAccountOption` shape. Both the organization and claim repositories
 * import from here; previously this was implemented twice with subtly
 * different inline types (e.g. `LimitPeriod` retyped as a literal union in
 * `claim.repository.ts`).
 *
 * The argument is loosely typed against an unknown Prisma row so callers
 * don't need to align with a specific Prisma include shape.
 */
export type ChartAccountRow = {
  id: string
  code: string
  name: string
  type: string | null
  status: string | null
  isSelectable: boolean
  isBankAccount: boolean
  isCustom: boolean
  isDisabled: boolean
  xeroConnectionId?: string | null
  limitAmount?: unknown
  limitPeriod?: string | null
  limitScope?: string | null
  allowMileageClaim?: boolean | null
  mileageRate?: unknown
}

export function mapChartAccount(
  account?: ChartAccountRow | null
): ChartOfAccountOption | undefined {
  if (!account) return undefined

  return {
    id: account.id,
    code: account.code,
    name: account.name,
    type: account.type ?? undefined,
    status: account.status ?? undefined,
    isSelectable: account.isSelectable,
    isBankAccount: account.isBankAccount,
    isCustom: account.isCustom,
    isDisabled: account.isDisabled,
    xeroConnectionId: account.xeroConnectionId ?? undefined,
    limitAmount: toNumber(account.limitAmount),
    limitPeriod: (account.limitPeriod as LimitPeriod | null | undefined) ?? undefined,
    limitScope: (account.limitScope as LimitScope | null | undefined) ?? undefined,
    allowMileageClaim: Boolean(account.allowMileageClaim),
    mileageRate: toNumber(account.mileageRate),
  }
}
