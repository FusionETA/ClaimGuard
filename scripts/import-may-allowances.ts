/// One-off: import May 2026 allowances from the Jan–May payroll PDF into
/// the May 2026 PayrollRun's PayrollRunAdjustment.manualLineItems.
///
/// Dry-run by default — prints what would be written without touching the DB.
/// Pass --apply to commit.
///
///   npx tsx scripts/import-may-allowances.ts
///   npx tsx scripts/import-may-allowances.ts --apply
import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"
import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

const APPLY = process.argv.includes("--apply")

// ─── PDF-extracted May 2026 data ──────────────────────────────────────────
// Source: "jan to may (2).pdf", re-extracted 2026-07-03.
// Shape: { empNo, basicSalary (PDF May BASIC), breakdown: { [pdfLabel]: amount } }
// basicSalary is cross-checked against PayrollProfile.monthlySalary before
// writing — mismatches are printed and the employee is skipped.

const PDF_DATA: Array<{ empNo: string; basicSalary: number; breakdown: Record<string, number> }> = [
  { empNo: "AA0002", basicSalary: 12000.0, breakdown: { "PETROL ALL": 350.0 } },
  { empNo: "AA0003", basicSalary: 12000.0, breakdown: { "PETROL ALL": 1000.0, "MV EXP.ALL": 500.0, "ADD.ALL": 7000.0 } },
  { empNo: "AA0008", basicSalary: 9500.0, breakdown: { "PETROL ALL": 600.0 } },
  { empNo: "AA0023", basicSalary: 8800.0, breakdown: { "PETROL ALL": 500.0, "ADD.ALL": 250.0 } },
  { empNo: "AA0033", basicSalary: 9450.0, breakdown: { "PETROL ALL": 500.0, "MV EXP.ALL": 200.0, "EXP.ALL": 150.0, "OTH. DEDUCTION": 1000.0 } },
  { empNo: "AA0074", basicSalary: 7800.0, breakdown: { "OTH. DEDUCTION": 1620.15 } },
  { empNo: "AA0131", basicSalary: 5100.0, breakdown: { "PETROL ALL": 320.0, "OTH. DEDUCTION": 600.0 } },
  { empNo: "AA0154", basicSalary: 7100.0, breakdown: { "PETROL ALL": 450.0, "ADD.ALL": 450.0 } },
  { empNo: "AA0161", basicSalary: 5805.0, breakdown: { "PETROL ALL": 150.0, "OTH. DEDUCTION": 309.33 } },
  { empNo: "AA0249", basicSalary: 10350.0, breakdown: { "PETROL ALL": 750.0, "ADD.ALL": 800.0, "OTH. DEDUCTION": 1000.0 } },
  { empNo: "AA0304", basicSalary: 5900.0, breakdown: { "PETROL ALL": 500.0, "OTH. DEDUCTION": 1000.0 } },
  { empNo: "AA0336", basicSalary: 5900.0, breakdown: { "MV EXP.ALL": 250.0, "OTH. DEDUCTION": 1000.0 } },
  { empNo: "AA0354", basicSalary: 7700.0, breakdown: { "PETROL ALL": 300.0, "OTH. DEDUCTION": 420.0 } },
  { empNo: "AA0359", basicSalary: 9000.0, breakdown: { "PETROL ALL": 300.0, "OTH. DEDUCTION": 1000.0 } },
  { empNo: "AA0417", basicSalary: 9700.0, breakdown: { "PETROL ALL": 600.0, "OTH. DEDUCTION": 500.77 } },
  { empNo: "AA0474", basicSalary: 5900.0, breakdown: { "PETROL ALL": 300.0, "OTH. DEDUCTION": 2500.0 } },
  { empNo: "AA0514", basicSalary: 9600.0, breakdown: { "PETROL ALL": 400.0, "MV EXP.ALL": 200.0, "OTH. DEDUCTION": 1300.0 } },
  { empNo: "AA0536", basicSalary: 9731.0, breakdown: { "PETROL ALL": 700.0, "MV EXP.ALL": 200.0, "ADD.ALL": 300.0, "OTH. DEDUCTION": 680.0, "ZAKAT": 180.0 } },
  { empNo: "AA0556", basicSalary: 7950.0, breakdown: { "PETROL ALL": 600.0, "MV EXP.ALL": 200.0 } },
  { empNo: "AA0569", basicSalary: 5400.0, breakdown: { "PETROL ALL": 400.0 } },
  { empNo: "AA0582", basicSalary: 9250.0, breakdown: { "PETROL ALL": 350.0, "MV EXP.ALL": 200.0, "OTH. DEDUCTION": 250.0 } },
  { empNo: "AA0597", basicSalary: 9700.0, breakdown: { "PETROL ALL": 500.0, "MV EXP.ALL": 200.0, "ADD.ALL": 1500.0 } },
  { empNo: "AA0614", basicSalary: 6250.0, breakdown: { "PETROL ALL": 500.0, "MV EXP.ALL": 200.0, "OTH. DEDUCTION": 463.79 } },
  { empNo: "AA0620", basicSalary: 18300.0, breakdown: { "PETROL ALL": 500.0 } },
  { empNo: "AA0625", basicSalary: 10700.0, breakdown: { "PETROL ALL": 600.0, "MV EXP.ALL": 500.0, "OTH. DEDUCTION": 200.0 } },
  { empNo: "AA0648", basicSalary: 11000.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "HP EXP.ALL": 50.0, "OTH. DEDUCTION": 400.0, "ZAKAT": 150.0 } },
  { empNo: "AA0657", basicSalary: 6450.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "HP EXP.ALL": 50.0, "OTH. DEDUCTION": 1000.0 } },
  { empNo: "AA0676", basicSalary: 9000.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "OTH. DEDUCTION": 150.0, "ZAKAT": 150.0 } },
  { empNo: "AA0722", basicSalary: 5500.0, breakdown: { "PETROL ALL": 500.0, "EXP.ALL": 150.0 } },
  { empNo: "AA0744", basicSalary: 6320.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "HP EXP.ALL": 50.0 } },
  { empNo: "AA0758", basicSalary: 8500.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "AA0779", basicSalary: 6300.0, breakdown: { "PETROL ALL": 1200.0, "MV EXP.ALL": 200.0 } },
  { empNo: "AA0784", basicSalary: 6400.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "AA0788", basicSalary: 6800.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "ADD.ALL": 150.0, "HP EXP.ALL": 50.0 } },
  { empNo: "AA0790", basicSalary: 5450.0, breakdown: { "PETROL ALL": 500.0, "MV EXP.ALL": 200.0, "ADD.ALL": 150.0, "OTH. DEDUCTION": 275.0 } },
  { empNo: "AA0792", basicSalary: 6250.0, breakdown: { "PETROL ALL": 500.0, "OTH. DEDUCTION": 600.0 } },
  { empNo: "AA0794", basicSalary: 7500.0, breakdown: { "PETROL ALL": 450.0, "MV EXP.ALL": 200.0, "HOUSE ALL": 500.0 } },
  { empNo: "AA0798", basicSalary: 7150.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "AA0804", basicSalary: 8600.0, breakdown: { "PETROL ALL": 500.0, "MV EXP.ALL": 200.0 } },
  { empNo: "AA0818", basicSalary: 6300.0, breakdown: { "PETROL ALL": 500.0, "OUT.EXP.ALL": 500.0, "OTH. DEDUCTION": 1000.0 } },
  { empNo: "AA0819", basicSalary: 6100.0, breakdown: { "PETROL ALL": 400.0, "ADD.ALL": 1000.0, "OTH. DEDUCTION": 252.55 } },
  { empNo: "AA0836", basicSalary: 9300.0, breakdown: { "PETROL ALL": 400.0, "MV EXP.ALL": 300.0 } },
  { empNo: "AA0844", basicSalary: 5600.0, breakdown: { "PETROL ALL": 400.0 } },
  { empNo: "AA0862", basicSalary: 9300.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "ADD.ALL": 150.0, "OTH. DEDUCTION": 270.0 } },
  { empNo: "AA0867", basicSalary: 4400.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "AA0901", basicSalary: 4750.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "AA0908", basicSalary: 4650.0, breakdown: { "PETROL ALL": 400.0 } },
  { empNo: "AA0909", basicSalary: 6150.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "ADD.ALL": 150.0 } },
  { empNo: "AA0915", basicSalary: 5400.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "AA0924", basicSalary: 5300.0, breakdown: { "PETROL ALL": 250.0 } },
  { empNo: "AA0949", basicSalary: 5500.0, breakdown: { "PETROL ALL": 300.0, "OTH. DEDUCTION": 2640.0 } },
  { empNo: "AA0955", basicSalary: 7268.0, breakdown: { "PETROL ALL": 300.0 } },
  { empNo: "AA0961", basicSalary: 4600.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "AA0966", basicSalary: 8200.0, breakdown: { "PETROL ALL": 400.0, "MV EXP.ALL": 200.0 } },
  { empNo: "AA0970", basicSalary: 9000.0, breakdown: { "PETROL ALL": 830.0, "MV EXP.ALL": 500.0, "OTH. DEDUCTION": 800.0, "ZAKAT": 500.0 } },
  { empNo: "AA0979", basicSalary: 7950.0, breakdown: { "PETROL ALL": 200.0, "MV EXP.ALL": 200.0 } },
  { empNo: "AA0980", basicSalary: 7000.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "AA0985", basicSalary: 5650.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "AA0986", basicSalary: 6500.0, breakdown: { "PETROL ALL": 700.0 } },
  { empNo: "AA0987", basicSalary: 6350.0, breakdown: { "PETROL ALL": 500.0 } },
  { empNo: "AA0988", basicSalary: 3440.0, breakdown: { "PETROL ALL": 280.0, "MV EXP.ALL": 200.0 } },
  { empNo: "AA0990", basicSalary: 4700.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "OUT.EXP.ALL": 1500.0 } },
  { empNo: "AA0992", basicSalary: 7950.0, breakdown: { "PETROL ALL": 200.0 } },
  { empNo: "AA0994", basicSalary: 3950.0, breakdown: { "PETROL ALL": 400.0, "MV EXP.ALL": 200.0 } },
  { empNo: "AA0995", basicSalary: 2800.0, breakdown: { "PETROL ALL": 150.0, "MV EXP.ALL": 150.0, "OTH. DEDUCTION": 300.0 } },
  { empNo: "AA0996", basicSalary: 4000.0, breakdown: { "PETROL ALL": 200.0, "MV EXP.ALL": 200.0 } },
  { empNo: "AA0997", basicSalary: 3600.0, breakdown: { "PETROL ALL": 200.0, "MV EXP.ALL": 200.0 } },
  { empNo: "AA0998", basicSalary: 6500.0, breakdown: { "PETROL ALL": 500.0, "ADD.ALL": 500.0 } },
  { empNo: "AA1000", basicSalary: 6300.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E122",  basicSalary: 5300.0, breakdown: { "PETROL ALL": 300.0 } },
  { empNo: "E133",  basicSalary: 4200.0, breakdown: { "MV EXP.ALL": 200.0, "HP EXP.ALL": 50.0, "OTH. DEDUCTION": 256.67 } },
  { empNo: "E142",  basicSalary: 3650.0, breakdown: { "ADD.ALL": 80.0 } },
  { empNo: "E155",  basicSalary: 4067.31, breakdown: { "PETROL ALL": 300.0 } },
  { empNo: "E161",  basicSalary: 4278.85, breakdown: { "MV EXP.ALL": 200.0 } },
  { empNo: "E170",  basicSalary: 5500.0, breakdown: { "PETROL ALL": 400.0, "MV EXP.ALL": 200.0, "ADD.ALL": 150.0, "EXP.ALL": 500.0 } },
  { empNo: "E175",  basicSalary: 3500.0, breakdown: { "PETROL ALL": 200.0 } },
  { empNo: "E186",  basicSalary: 7400.0, breakdown: { "PETROL ALL": 500.0 } },
  { empNo: "E188",  basicSalary: 3200.0, breakdown: { "PETROL ALL": 850.0, "OTH. DEDUCTION": 500.0 } },
  { empNo: "E189",  basicSalary: 5800.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "OTH. DEDUCTION": 200.0 } },
  { empNo: "E193",  basicSalary: 3800.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "OTH. DEDUCTION": 300.0 } },
  { empNo: "E198",  basicSalary: 3900.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E200",  basicSalary: 3850.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E201",  basicSalary: 5200.0, breakdown: { "PETROL ALL": 200.0, "MV EXP.ALL": 200.0, "OUT.EXP.ALL": 2000.0 } },
  { empNo: "E206",  basicSalary: 3300.0, breakdown: { "PETROL ALL": 200.0, "MV EXP.ALL": 200.0, "OTH. DEDUCTION": 160.0 } },
  { empNo: "E208",  basicSalary: 3300.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "OUT.EXP.ALL": 500.0 } },
  { empNo: "E209",  basicSalary: 7000.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "OTH. DEDUCTION": 200.0 } },
  { empNo: "E211",  basicSalary: 3100.0, breakdown: { "OTH. DEDUCTION": 1035.56 } },
  { empNo: "E212",  basicSalary: 3400.0, breakdown: { "PETROL ALL": 300.0 } },
  { empNo: "E217",  basicSalary: 4650.0, breakdown: { "PETROL ALL": 350.0, "OTH. DEDUCTION": 350.0 } },
  { empNo: "E220",  basicSalary: 3100.0, breakdown: { "PETROL ALL": 200.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E221",  basicSalary: 3365.38, breakdown: { "PETROL ALL": 200.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E223",  basicSalary: 3700.0, breakdown: { "PETROL ALL": 200.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E224",  basicSalary: 2800.0, breakdown: { "PETROL ALL": 200.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E232",  basicSalary: 2650.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E234",  basicSalary: 4000.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E235",  basicSalary: 3700.0, breakdown: { "PETROL ALL": 100.0, "MV EXP.ALL": 100.0 } },
  { empNo: "E238",  basicSalary: 2700.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E239",  basicSalary: 3500.0, breakdown: { "PETROL ALL": 150.0, "MV EXP.ALL": 150.0 } },
  { empNo: "E247",  basicSalary: 4500.0, breakdown: { "PETROL ALL": 200.0, "MV EXP.ALL": 300.0 } },
  { empNo: "E248",  basicSalary: 5200.0, breakdown: { "PETROL ALL": 200.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E251",  basicSalary: 4300.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "OUT.EXP.ALL": 1500.0 } },
  { empNo: "E252",  basicSalary: 5000.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "OTH. DEDUCTION": 250.0 } },
  { empNo: "E257",  basicSalary: 5700.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E258",  basicSalary: 6800.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E259",  basicSalary: 4950.0, breakdown: { "PETROL ALL": 200.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E260",  basicSalary: 3950.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E263",  basicSalary: 3800.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E264",  basicSalary: 6500.0, breakdown: { "PETROL ALL": 500.0, "ADD.ALL": 500.0 } },
  { empNo: "E266",  basicSalary: 3900.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E267",  basicSalary: 4000.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E268",  basicSalary: 4650.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E272",  basicSalary: 2746.15, breakdown: { "OTH. DEDUCTION": 500.0 } },
  { empNo: "E273",  basicSalary: 4500.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E276",  basicSalary: 6500.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "OTH. DEDUCTION": 1500.0 } },
  { empNo: "E277",  basicSalary: 4800.0, breakdown: { "PETROL ALL": 200.0, "MV EXP.ALL": 100.0 } },
  { empNo: "E278",  basicSalary: 5300.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "OTH. DEDUCTION": 200.0 } },
  { empNo: "E282",  basicSalary: 3500.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E289",  basicSalary: 3200.0, breakdown: { "PETROL ALL": 200.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E291",  basicSalary: 3200.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E293",  basicSalary: 3500.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E296",  basicSalary: 5288.46, breakdown: { "PETROL ALL": 200.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E297",  basicSalary: 3800.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E306",  basicSalary: 2700.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E310",  basicSalary: 6600.0, breakdown: { "PETROL ALL": 500.0, "OTH. DEDUCTION": 6053.2 } },
  { empNo: "E313",  basicSalary: 3600.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E314",  basicSalary: 3200.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E316",  basicSalary: 3173.08, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E317",  basicSalary: 5000.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E318",  basicSalary: 5600.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E319",  basicSalary: 4200.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E320",  basicSalary: 6634.62, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E323",  basicSalary: 6000.0, breakdown: { "PETROL ALL": 200.0 } },
  { empNo: "E325",  basicSalary: 3500.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E326",  basicSalary: 3500.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E328",  basicSalary: 3300.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E329",  basicSalary: 5000.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "OTH. DEDUCTION": 1500.0 } },
  { empNo: "E331",  basicSalary: 5500.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E332",  basicSalary: 3015.38, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E333",  basicSalary: 3400.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E334",  basicSalary: 3700.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E335",  basicSalary: 4326.92, breakdown: { "PETROL ALL": 300.0 } },
  { empNo: "E336",  basicSalary: 4050.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E337",  basicSalary: 3750.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E338",  basicSalary: 7500.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E339",  basicSalary: 4000.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E340",  basicSalary: 3200.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E343",  basicSalary: 4800.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "OUT.EXP.ALL": 1000.0, "OTH. DEDUCTION": 540.0 } },
  { empNo: "E344",  basicSalary: 7000.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E345",  basicSalary: 3600.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E346",  basicSalary: 3500.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E347",  basicSalary: 6500.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E348",  basicSalary: 9100.0, breakdown: { "ADD.ALL": 886.0 } },
  { empNo: "E350",  basicSalary: 3300.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "OTH. DEDUCTION": 900.0 } },
  { empNo: "E351",  basicSalary: 9500.0, breakdown: { "PETROL ALL": 800.0, "MV EXP.ALL": 300.0, "ADD.ALL": 250.0 } },
  { empNo: "E352",  basicSalary: 692.31, breakdown: { "PETROL ALL": 48.4, "MV EXP.ALL": 32.3 } },
  { empNo: "E353",  basicSalary: 2500.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "OTH. DEDUCTION": 728.6 } },
  { empNo: "E354",  basicSalary: 4500.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E355",  basicSalary: 4000.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E359",  basicSalary: 2844.23, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E360",  basicSalary: 3170.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "REFUND": 370.88 } },
  { empNo: "E361",  basicSalary: 3000.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0, "REFUND": 467.72 } },
  { empNo: "E362",  basicSalary: 1900.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E363",  basicSalary: 2980.77, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E364",  basicSalary: 4500.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E365",  basicSalary: 3046.15, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E366",  basicSalary: 3000.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E367",  basicSalary: 2884.62, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E368",  basicSalary: 4000.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E369",  basicSalary: 3692.31, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E370",  basicSalary: 2700.0, breakdown: { "PETROL ALL": 300.0, "MV EXP.ALL": 200.0 } },
  { empNo: "E371",  basicSalary: 1200.0, breakdown: { "MEAL": 200.0, "HOUSE ALL": 300.0, "REFUND": 835.32 } },
  { empNo: "E372",  basicSalary: 4846.15, breakdown: { "PETROL ALL": 203.28, "HP EXP.ALL": 135.66 } },
  { empNo: "E373",  basicSalary: 1153.85, breakdown: { "PETROL ALL": 135.52, "MV EXP.ALL": 90.44, "HP EXP.ALL": 22.68 } },
  { empNo: "E374",  basicSalary: 1661.54, breakdown: { "PETROL ALL": 135.52, "MV EXP.ALL": 90.44, "HP EXP.ALL": 22.68 } },
]

// ─── Category mapping ──────────────────────────────────────────────────────
// PETROL ALL + MV EXP.ALL → allowance_travel_private (combined)
// OUT.EXP.ALL              → allowance_travel_official
// ADD.ALL                  → allowance_travel_official (treatAsRecurring=true — same amount every month)
// MEAL                     → allowance_meal
// HP EXP.ALL               → allowance_phone_bill
// HOUSE ALL                → bik_living_accommodation
// EXP.ALL                  → allowance_standard
// REFUND                   → wages_expense_claim
// OTH. DEDUCTION           → deduct_miscellaneous
// ZAKAT                    → deduct_zakat (offsets PCB per calcPayslip)

type LineItem = {
  kind: "ALLOWANCE" | "DEDUCTION" | "REIMBURSEMENT"
  category: string | null
  label: string
  amount: number
  treatAsRecurring?: boolean
}

function buildLineItems(breakdown: Record<string, number>): LineItem[] {
  // Combine PETROL ALL + MV EXP.ALL into one travel_private line
  const travelPrivate =
    (breakdown["PETROL ALL"] ?? 0) + (breakdown["MV EXP.ALL"] ?? 0)

  const items: LineItem[] = []

  if (travelPrivate > 0) {
    items.push({
      kind: "ALLOWANCE",
      category: "allowance_travel_private",
      label: "Travel/Petrol Allowance (Private Use/Commuting)",
      amount: Math.round(travelPrivate * 100) / 100,
    })
  }

  const outExp = breakdown["OUT.EXP.ALL"] ?? 0
  if (outExp > 0) {
    items.push({
      kind: "ALLOWANCE",
      category: "allowance_travel_official",
      label: "Travel Allowance (Official Duties)",
      amount: outExp,
    })
  }

  const addAll = breakdown["ADD.ALL"] ?? 0
  if (addAll > 0) {
    items.push({
      kind: "ALLOWANCE",
      category: "allowance_travel_official",
      label: "Official Duty Allowance",
      amount: addAll,
      treatAsRecurring: true,
    })
  }

  const meal = breakdown["MEAL"] ?? 0
  if (meal > 0) {
    items.push({
      kind: "ALLOWANCE",
      category: "allowance_meal",
      label: "Meal Allowance",
      amount: meal,
    })
  }

  const phone = breakdown["HP EXP.ALL"] ?? 0
  if (phone > 0) {
    items.push({
      kind: "ALLOWANCE",
      category: "allowance_phone_bill",
      label: "Phone Bill Allowance",
      amount: Math.round(phone * 100) / 100,
    })
  }

  const house = breakdown["HOUSE ALL"] ?? 0
  if (house > 0) {
    items.push({
      kind: "ALLOWANCE",
      category: "bik_living_accommodation",
      label: "Living Accommodation (BIK)",
      amount: house,
    })
  }

  const exp = breakdown["EXP.ALL"] ?? 0
  if (exp > 0) {
    items.push({
      kind: "ALLOWANCE",
      category: "allowance_standard",
      label: "Expense Allowance",
      amount: exp,
    })
  }

  const refund = breakdown["REFUND"] ?? 0
  if (refund > 0) {
    items.push({
      kind: "REIMBURSEMENT",
      category: "wages_expense_claim",
      label: "Expense Claim Refund",
      amount: Math.round(refund * 100) / 100,
    })
  }

  const othDeduction = breakdown["OTH. DEDUCTION"] ?? 0
  if (othDeduction > 0) {
    items.push({
      kind: "DEDUCTION",
      category: "deduct_miscellaneous",
      label: "OTH. DEDUCTION",
      amount: Math.round(othDeduction * 100) / 100,
    })
  }

  const zakat = breakdown["ZAKAT"] ?? 0
  if (zakat > 0) {
    items.push({
      kind: "DEDUCTION",
      category: "deduct_zakat",
      label: "Zakat",
      amount: Math.round(zakat * 100) / 100,
    })
  }

  return items
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const cfg = getDatabaseConnectionConfig()
  if (!cfg) throw new Error("Missing DATABASE_URL env.")

  const adapter = new PrismaMariaDb({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl,
  })
  const prisma = new PrismaClient({ adapter } as never)

  console.log(APPLY ? "🚀  APPLY mode — writing to DB" : "🔍  DRY RUN — no DB writes\n")

  // Find May 2026 payroll run(s)
  const runs = await prisma.payrollRun.findMany({
    where: { periodYear: 2026, periodMonth: 5 },
    select: { id: true, organizationId: true, status: true },
  })

  if (runs.length === 0) {
    console.error("❌  No PayrollRun found for May 2026. Create the run first in the admin UI.")
    process.exit(1)
  }
  if (runs.length > 1) {
    console.log(`Found ${runs.length} May 2026 runs (multiple orgs):`)
    runs.forEach((r) => console.log(`  ${r.id}  org=${r.organizationId}  status=${r.status}`))
    console.log("\nScript will process all of them. Pass --run-id=<id> to target one (not yet implemented).")
  }

  for (const run of runs) {
    console.log(`\nPayrollRun ${run.id}  org=${run.organizationId}  status=${run.status}`)

    // Load all EmployeeProfiles + PayrollProfiles for this org
    const profiles = await prisma.employeeProfile.findMany({
      where: { organizationId: run.organizationId },
      select: {
        id: true,
        employeeId: true,
        payrollProfile: { select: { monthlySalary: true } },
      },
    })
    const profileByEmpNo = new Map(
      profiles.map((p) => [p.employeeId, { id: p.id, monthlySalary: p.payrollProfile?.monthlySalary ?? null }])
    )

    let matched = 0, skipped = 0, salaryMismatch = 0, created = 0, updated = 0

    for (const row of PDF_DATA) {
      const profile = profileByEmpNo.get(row.empNo)
      if (!profile) {
        console.log(`  ⚠️  ${row.empNo} — not found in org ${run.organizationId}, skipping`)
        skipped++
        continue
      }
      const profileId = profile.id

      // Salary check: PDF basicSalary must match PayrollProfile.monthlySalary
      const dbSalary = profile.monthlySalary != null ? Number(profile.monthlySalary) : null
      if (dbSalary === null) {
        console.log(`  ⚠️  ${row.empNo} — no PayrollProfile/monthlySalary in DB, skipping`)
        salaryMismatch++
        continue
      }
      if (Math.round(dbSalary * 100) !== Math.round(row.basicSalary * 100)) {
        console.log(
          `  ❌  ${row.empNo} — salary mismatch: PDF=${row.basicSalary.toFixed(2)} DB=${dbSalary.toFixed(2)}, skipping`
        )
        salaryMismatch++
        continue
      }

      const lineItems = buildLineItems(row.breakdown)
      if (lineItems.length === 0) continue

      const total = lineItems.reduce((s, li) => s + li.amount, 0)
      const summary = lineItems.map((li) => `${li.label}: ${li.amount.toFixed(2)}`).join(", ")

      // Check for existing adjustment row
      const existing = await prisma.payrollRunAdjustment.findUnique({
        where: { payrollRunId_employeeProfileId: { payrollRunId: run.id, employeeProfileId: profileId } },
        select: { id: true, manualLineItems: true },
      })

      if (existing) {
        const existingItems = Array.isArray(existing.manualLineItems) ? existing.manualLineItems : []
        const existingTotal = (existingItems as LineItem[]).reduce((s, li) => s + (li.amount ?? 0), 0)
        console.log(`  ${existing ? "✏️ " : "➕"} ${row.empNo}  total=${total.toFixed(2)}  [${summary}]`)
        if (existingTotal > 0) {
          console.log(`    ⚠️  Already has ${existingTotal.toFixed(2)} in manualLineItems — will REPLACE`)
        }
        if (APPLY) {
          await prisma.payrollRunAdjustment.update({
            where: { id: existing.id },
            data: { manualLineItems: lineItems as never, lastMutatedAt: new Date() } as never,
          })
          updated++
        }
      } else {
        console.log(`  ➕ ${row.empNo}  total=${total.toFixed(2)}  [${summary}]`)
        if (APPLY) {
          await prisma.payrollRunAdjustment.create({
            data: {
              payrollRunId: run.id,
              employeeProfileId: profileId,
              otNormalHours: 0,
              otRestHours: 0,
              otPublicHours: 0,
              manualLineItems: lineItems as never,
              fixedAllowanceOverrides: {} as never,
              notes: "Imported from Jan–May 2026 payroll PDF",
            },
          })
          created++
        }
      }

      matched++
    }

    console.log(`\n  Summary: ${matched} matched, ${skipped} not found in org, ${salaryMismatch} salary mismatch, ${created} created, ${updated} updated`)
  }

  if (!APPLY) {
    console.log("\n✅  Dry run complete. Run with --apply to write to DB.")
  } else {
    console.log("\n✅  Done.")
  }

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
