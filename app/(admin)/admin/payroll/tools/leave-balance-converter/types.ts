import type { ConvertedRow } from "@/modules/leave/domain/payroll-panda-balances"

/**
 * Response shape for `convertPayrollPandaBalancesAction`.
 *
 * Lives here rather than in `actions.ts` because a `"use server"` file
 * may only export async functions — a `type` export builds locally but
 * fails the deploy with "A 'use server' file can only export async
 * functions, found object". See app/CLAUDE.md.
 */
export type ConvertResponse = {
  ok: boolean
  message: string
  data?: {
    companyName: string | null
    asAtDate: string | null
    unit: "DAYS" | "HOURS" | null
    memberCount: number | null
    year: number
    sheetName: string
    otherSheets: string[]
    rows: ConvertedRow[]
    problems: string[]
  }
}
