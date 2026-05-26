import Link from "next/link"
import { isAdminRole } from "@/lib/auth/types"
import type { Route } from "next"
import { redirect } from "next/navigation"
import {
  ClipboardList,
  Clock,
  FileSpreadsheet,
  Settings2,
  Users,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { getCurrentSession } from "@/lib/auth/session"

/**
 * Payroll overview / landing page.
 *
 * v1 scope — minimal: shows the three sub-sections (Employees, Runs,
 * Settings) as navigation cards. The runs / settings pages are stubs
 * for now (built out in Phases 2 + 3); Employees is functional after
 * Phase 1.
 */
export default async function AdminPayrollPage() {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) redirect("/login")

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-foreground">
          Payroll
        </h1>
        <p className="text-sm text-muted-foreground">
          Automated payroll for Malaysian operations. Set up employee
          statutory information, run monthly payroll, and issue payslips.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="flex h-full flex-col">
          <CardHeader className="flex-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4" />
              Employees
            </CardTitle>
            <CardDescription>
              Onboard employees into payroll — capture statutory info,
              banking, salary, and statutory contributions.
            </CardDescription>
          </CardHeader>
          <CardContent className="mt-auto">
            <Button asChild>
              <Link href="/admin/payroll/employees">Manage employees</Link>
            </Button>
          </CardContent>
        </Card>

        <Card className="flex h-full flex-col">
          <CardHeader className="flex-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <ClipboardList className="h-4 w-4" />
              Payroll Runs
            </CardTitle>
            <CardDescription>
              Create monthly payroll drafts, review payslips, submit, and
              attach approved claims as reimbursements.
            </CardDescription>
          </CardHeader>
          <CardContent className="mt-auto">
            <Button asChild>
              <Link href="/admin/payroll/runs">Open runs</Link>
            </Button>
          </CardContent>
        </Card>

        <Card className="flex h-full flex-col">
          <CardHeader className="flex-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileSpreadsheet className="h-4 w-4" />
              Annual Tax Forms
            </CardTitle>
            <CardDescription>
              Year-end Form EA, Form E + CP8D, and CP8D TXT files for
              LHDN&apos;s e-CP8D upload.
            </CardDescription>
          </CardHeader>
          <CardContent className="mt-auto">
            <Button asChild>
              <Link href={"/admin/payroll/annual-forms" as Route}>
                Open annual forms
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card className="flex h-full flex-col">
          <CardHeader className="flex-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <Settings2 className="h-4 w-4" />
              Settings
            </CardTitle>
            <CardDescription>
              OT multipliers, working-days rule, default EPF rates, Form
              E employer particulars.
            </CardDescription>
          </CardHeader>
          <CardContent className="mt-auto">
            <Button asChild>
              <Link href="/admin/payroll/settings">Open settings</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* ─── Calculation transparency ──────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            How each line is calculated
          </CardTitle>
          <CardDescription>
            Every statutory contribution follows the gazetted rule. The
            source column lists the regulator&apos;s published schedule
            for each row so you can cross-check independently.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">Line</TableHead>
                <TableHead>Wage base</TableHead>
                <TableHead>Rate / method</TableHead>
                <TableHead className="w-[180px]">Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">Basic pay</TableCell>
                <TableCell>
                  Monthly salary, prorated by join/leave dates against
                  the org&apos;s working-days basis (calendar or 26-day).
                  Hourly employees: rate × worked hours.
                </TableCell>
                <TableCell>Salary × proration factor</TableCell>
                <TableCell className="text-muted-foreground">
                  Employment Act 1955
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Overtime</TableCell>
                <TableCell>
                  Hourly rate = monthly salary ÷ (working-days × 8h),
                  multiplied by OT hours and the org&apos;s OT rates
                  (Normal / Rest day / Public holiday).
                </TableCell>
                <TableCell>
                  Default multipliers: 1.5× / 2.0× / 3.0× (configurable
                  in Settings)
                </TableCell>
                <TableCell className="text-muted-foreground">
                  Employment Act 1955, Sec. 60A
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">EPF (KWSP)</TableCell>
                <TableCell>
                  Basic + allowances (per category meta). Excludes OT
                  and reimbursements. EPF branch picked from
                  nationality, PR status, and age.
                </TableCell>
                <TableCell>
                  Third Schedule lookup table for wages ≤ RM 20,000
                  (stepped). Exact percentage rounded up to next ringgit
                  above. Voluntary contributions stack on top.
                </TableCell>
                <TableCell className="text-muted-foreground">
                  KWSP Third Schedule
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">SOCSO</TableCell>
                <TableCell>
                  Basic + OT + allowances, capped at RM 6,000/month.
                  Category 2 (employer-only) applied for employees aged
                  60+ or foreign workers.
                </TableCell>
                <TableCell>
                  Act 4 Third Schedule (65-row stepped table). Cat 1
                  ≈ 1.75% employer + 0.5% employee; Cat 2 ≈ 1.25%
                  employer only.
                </TableCell>
                <TableCell className="text-muted-foreground">
                  PERKESO Act 4
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">EIS</TableCell>
                <TableCell>
                  Basic + OT + allowances, capped at RM 6,000/month.
                  Applies to Malaysian citizens, PR, and foreign workers
                  with a valid permit, aged 18–60.
                </TableCell>
                <TableCell>
                  Act 800 Third Schedule (65-row stepped table) ≈ 0.2%
                  each side.
                </TableCell>
                <TableCell className="text-muted-foreground">
                  PERKESO Act 800
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">
                  PCB (resident)
                </TableCell>
                <TableCell>
                  Basic + OT + taxable allowances + additional
                  remuneration (bonus, commission, arrears, director
                  fee, gratuity). Tax-exempt limits enforced per
                  category. YTD income, EPF (capped RM 4,000), SOCSO
                  + EIS (actuals-only, capped RM 350, auto-applied so
                  the employee doesn&apos;t need to submit Form TP1),
                  zakat, and prior-month PCB carried forward —
                  including TP3 prev-employer figures when applicable.
                </TableCell>
                <TableCell>
                  Normal: <code>[(P − M)R + B − (Z + X)] ÷ (n+1)</code>.
                  Additional remuneration: tax delta vs. annual
                  chargeable income, no projection. RM 10 minimum
                  threshold + LHDN rounding (truncate to 2dp, round up
                  to next 5 sen) applied to each component.
                </TableCell>
                <TableCell className="text-muted-foreground">
                  LHDN MTD Spec 2026
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">
                  PCB (non-resident)
                </TableCell>
                <TableCell>
                  Same wage base as resident PCB. No personal reliefs.
                </TableCell>
                <TableCell>Flat 30% of taxable remuneration.</TableCell>
                <TableCell className="text-muted-foreground">
                  ITA 1967 Schedule 1 Part II
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">
                  HRDF (HRD Corp levy)
                </TableCell>
                <TableCell>
                  Basic + fixed allowances of a like nature + leave pay
                  + arrears. Excludes travel allowance, bonus,
                  commission, gratuity, BIK, and reimbursements per
                  PSMB Act Sec. 2. Malaysian citizens only.
                </TableCell>
                <TableCell>
                  1.0% for Part I employers (≥10 employees) or 0.5% for
                  Part II opt-in employers (5–9 employees).
                </TableCell>
                <TableCell className="text-muted-foreground">
                  PSMB Act 2001
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Zakat</TableCell>
                <TableCell>
                  Captured via the <code>deduct_zakat</code> line item
                  on the payslip.
                </TableCell>
                <TableCell>
                  Offsets PCB for the month (Net MTD floored at RM 0).
                  Accumulated zakat (Z) reduces annual chargeable
                  income in subsequent months&apos; PCB calc.
                </TableCell>
                <TableCell className="text-muted-foreground">
                  LHDN MTD Spec 2026, Section E.5
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <p className="mt-4 text-xs text-muted-foreground">
            All LHDN / KWSP / PERKESO / HRD Corp rules above match the
            gazetted schedules row-for-row.
          </p>
        </CardContent>
      </Card>

      {/* ─── Upcoming functionality (roadmap transparency) ─────────── */}
      <Card className="border-amber-200/60 bg-amber-50/40 dark:border-amber-700/40 dark:bg-amber-950/15">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4 text-amber-700 dark:text-amber-400" />
            Upcoming features
          </CardTitle>
          <CardDescription>
            The following items are planned but not yet active. Until
            they ship, the workarounds noted below apply.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[240px]">Feature</TableHead>
                <TableHead>What it will do</TableHead>
                <TableHead>Workaround today</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">
                  PCB borne by employer (gross-up)
                </TableCell>
                <TableCell>
                  For employees on net-of-tax contracts, the system
                  will compute the perquisite tax via LHDN&apos;s
                  iterative gross-up so the employer pays the correct
                  PCB without under-withholding.
                </TableCell>
                <TableCell className="text-muted-foreground">
                  Leave the &ldquo;PCB borne by employer&rdquo; toggle
                  OFF on every profile. If you have a net-of-tax
                  arrangement, compute the gross-up externally and
                  enter the perquisite manually using the{" "}
                  <code>wages_tax_borne_by_employer</code> line item.
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
