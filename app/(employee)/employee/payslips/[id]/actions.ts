"use server"

import { revealEmployeePayslip } from "@/modules/payroll/application/services/employee-payroll.service"

/**
 * Verify the employee's password and, only on success, return the full
 * payslip payload for the client gate to render. The salary figures
 * never reach the browser until this resolves `ok: true` — the [id]
 * page ships only a lightweight header before unlock.
 */
export async function revealPayslipAction(payslipId: string, password: string) {
  return revealEmployeePayslip({ payslipId, password })
}
