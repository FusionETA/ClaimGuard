import Link from "next/link"
import type { Route } from "next"
import { redirect } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { isAdminRole } from "@/lib/auth/types"
import { getCurrentSession } from "@/lib/auth/session"
import { requireAdminModule } from "@/modules/organization/application/services/admin-access.service"
import { Button } from "@/components/ui/button"

import { LeaveBalanceConverterClient } from "./converter-client"

/**
 * TEMPORARY TOOL — Payroll Panda leave-balance converter.
 *
 * Turns a Payroll Panda "Time Off Balances" export into the CSV the
 * existing leave-balance importer accepts, so a migrating client's
 * balances don't have to be retyped.
 *
 * Deliberately does NOT write anything: it converts and hands back a
 * file, which the admin then uploads at Leave → Import. Payroll Panda
 * has no email column, so rows are matched on employee NAME — and a
 * name match that lands on the wrong person would silently corrupt
 * someone's entitlement. A human reviewing the preview between the two
 * steps is the safeguard.
 *
 * To remove once migrations are done: delete this folder, plus
 * `modules/leave/domain/payroll-panda-balances.ts` (+ its test),
 * `modules/leave/application/services/leave-migration-ref.service.ts`,
 * and the Tools card on the payroll hub.
 */
export default async function PayrollPandaConverterPage() {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) redirect("/login")
  await requireAdminModule("payroll")

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2 h-8">
          <Link href={"/admin/payroll" as Route}>
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Payroll
          </Link>
        </Button>
        <header className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">
            Payroll Panda leave balances
          </h1>
          <p className="text-sm text-muted-foreground">
            Convert a Payroll Panda “Time Off Balances” export into the
            leave-balance import file. Nothing is saved here — review the
            result, download the CSV, then upload it at Leave → Import.
          </p>
        </header>
      </div>

      <LeaveBalanceConverterClient />
    </div>
  )
}
