import { Card, CardContent, CardHeader, CardTitle } from "@/components/attendance/ui/card"
import { cn, formatCurrency } from "@/lib/utils"
import type { ChartAccountWithRemainingLimit } from "@/modules/claims/domain/models"

const PERIOD_LABELS: Record<"PER_CLAIM" | "MONTHLY" | "YEARLY", string> = {
  PER_CLAIM: "Per claim",
  MONTHLY: "This month",
  YEARLY: "This year",
}

const SCOPE_HINT: Record<"PER_EMPLOYEE" | "ORG_WIDE", string> = {
  PER_EMPLOYEE: "Your usage",
  ORG_WIDE: "Org-wide",
}

/**
 * Picks the bar colour based on how close the user is to the cap.
 * - <70 %: comfortable green
 * - 70–89 %: warning amber
 * - ≥90 %: at-risk red
 *
 * Tailwind palette tokens chosen to match the rest of the app's status pills.
 */
function usageTone(pct: number) {
  if (pct >= 90) return "bg-destructive"
  if (pct >= 70) return "bg-amber-500"
  return "bg-primary"
}

/**
 * Dashboard widget that shows accounts with a configured spend limit and how
 * much of that limit has been used so far in the current period.
 *
 * Skips PER_CLAIM accounts (they cap each individual claim, not accumulated
 * spend, so a "remaining" bar is meaningless). Returns null when nothing has
 * a limit — the card stays out of the way until policy is configured.
 *
 * Accepts both expense and mileage chart accounts; deduped by id since an
 * account could appear in both lists.
 */
export function SpendLimitsCard({
  accounts,
}: {
  accounts: ChartAccountWithRemainingLimit[]
}) {
  // Dedupe by id, then keep only those with an accumulating-period limit.
  const seen = new Set<string>()
  const limited = accounts
    .filter((account) => {
      if (seen.has(account.id)) return false
      seen.add(account.id)
      const lim = account.remainingLimit
      return Boolean(lim) && (lim?.period === "MONTHLY" || lim?.period === "YEARLY")
    })
    // Push closest-to-cap first so the most actionable rows are at the top.
    .sort((a, b) => {
      const pa = (a.remainingLimit!.used / a.remainingLimit!.limit) || 0
      const pb = (b.remainingLimit!.used / b.remainingLimit!.limit) || 0
      return pb - pa
    })

  if (limited.length === 0) return null

  return (
    <Card className="border border-border/70 bg-card/94 shadow-ambient backdrop-blur-sm">
      <CardHeader className="p-5 sm:p-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">
          Spend limits
        </p>
        <CardTitle className="text-lg font-extrabold sm:text-xl">
          Where you stand
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          Live usage on accounts with a configured cap.
        </p>
      </CardHeader>

      <CardContent className="space-y-3 p-5 pt-0 sm:space-y-4 sm:p-6 sm:pt-0">
        {limited.map((account) => {
          const lim = account.remainingLimit!
          const pct = lim.limit > 0 ? Math.min(100, (lim.used / lim.limit) * 100) : 0
          const tone = usageTone(pct)
          const remaining = Math.max(0, lim.remaining)

          return (
            <div
              key={account.id}
              className="rounded-[20px] border border-border/60 bg-surface-low p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-foreground">
                    {account.code} · {account.name}
                  </p>
                  <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                    {PERIOD_LABELS[lim.period]} · {SCOPE_HINT[lim.scope]}
                  </p>
                </div>
                <p className="text-sm font-semibold tabular-nums text-foreground">
                  {formatCurrency(lim.used)}
                  <span className="text-muted-foreground"> / {formatCurrency(lim.limit)}</span>
                </p>
              </div>

              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-border/60">
                <div
                  className={cn("h-full rounded-full transition-all", tone)}
                  style={{ width: `${pct}%` }}
                />
              </div>

              <p className="mt-2 text-xs text-muted-foreground">
                {remaining > 0
                  ? `${formatCurrency(remaining)} remaining`
                  : "Limit reached for this period"}
              </p>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
