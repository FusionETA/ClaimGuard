/**
 * Malaysian bank metadata — name, BIC (Bank Identifier Code), the
 * two-digit BNM/IBG code, and the Public Bank ECP payment mode (PBB
 * for Public Bank itself, IBG for every other domestic bank routed
 * through Interbank GIRO).
 *
 * Source: BNM IBG members list + Public Bank's published BIC code
 * reference (`pbebank.com > Business Banking > Cash Management`).
 * `bnmCode` values come from the CIMB BizConverter "BNM Code" sheet.
 *
 * The bank name keys are kept loose (case-insensitive substring match
 * via `findBankByName`) because the employee `PayrollProfile.bankName`
 * field is free-text — admins may type "Maybank", "MAYBANK BERHAD",
 * "Malayan Banking", etc. The matcher normalises and picks the best
 * fit.
 */

export type EcpPaymentMode = "PBB" | "IBG" | "REN"

/**
 * Native bulk-payroll upload formats AltomateHR can generate. One per
 * bank that publishes a file spec we implement — the value identifies
 * the renderer, not the bank, so Islamic subsidiaries share their
 * parent's format.
 */
export type PayrollFileFormat =
  | "PB_ECP_XLSX"
  | "MBB_M2E_TXT"
  | "CIMB_BIZCHANNEL_TXT"

export type MalaysianBank = {
  /// Canonical bank name (LHDN / BNM register).
  name: string
  /// Bank Identifier Code (BIC / SWIFT) — required for IBG payments
  /// per the Public Bank ECP spec.
  bic: string
  /// Two-digit BNM / IBG participating-bank code. Used by bulk-payment
  /// formats that route by national bank code instead of BIC — e.g.
  /// the CIMB BizChannel payroll file's "BNM Code" column.
  ///
  /// Islamic subsidiaries share their parent bank's code, which is how
  /// the IBG scheme (and CIMB's own code list) treats them.
  bnmCode: string
  /// Payment mode for Public Bank ECP. PBB = intra-Public-Bank
  /// (free, instant), IBG = inter-bank GIRO (fee, T+0/T+1).
  ecpMode: EcpPaymentMode
  /// The bulk-payroll file we can produce when the COMPANY banks here.
  /// Absent means we have no native format for that bank, so it isn't
  /// offered as a payroll disbursement bank (see
  /// `PAYROLL_DISBURSEMENT_BANKS`). Employees may still bank anywhere —
  /// this is about the payor account only.
  payrollFormat?: PayrollFileFormat
  /// Lower-case aliases used to match against free-text `bankName`
  /// on PayrollProfile. Should include the canonical name itself.
  aliases: readonly string[]
}

export const MALAYSIAN_BANKS: readonly MalaysianBank[] = [
  // Domestic Anchor Banks
  {
    name: "Malayan Banking Berhad",
    bic: "MBBEMYKL",
    payrollFormat: "MBB_M2E_TXT",
    bnmCode: "27",
    ecpMode: "IBG",
    aliases: ["maybank", "malayan banking", "mbb"],
  },
  {
    name: "Maybank Islamic Berhad",
    bic: "MBISMYKL",
    payrollFormat: "MBB_M2E_TXT",
    bnmCode: "27",
    ecpMode: "IBG",
    aliases: ["maybank islamic", "maybank islam"],
  },
  {
    name: "CIMB Bank Berhad",
    bic: "CIBBMYKL",
    payrollFormat: "CIMB_BIZCHANNEL_TXT",
    bnmCode: "35",
    ecpMode: "IBG",
    aliases: ["cimb", "cimb bank"],
  },
  {
    name: "CIMB Islamic Bank Berhad",
    bic: "CTBBMYKL",
    payrollFormat: "CIMB_BIZCHANNEL_TXT",
    bnmCode: "35",
    ecpMode: "IBG",
    aliases: ["cimb islamic"],
  },
  {
    name: "Public Bank Berhad",
    bic: "PBBEMYKL",
    payrollFormat: "PB_ECP_XLSX",
    bnmCode: "33",
    ecpMode: "PBB", // intra-Public-Bank
    aliases: ["public bank", "pbb", "public bank berhad"],
  },
  {
    name: "Public Islamic Bank Berhad",
    bic: "PIBEMYKL",
    payrollFormat: "PB_ECP_XLSX",
    bnmCode: "33",
    ecpMode: "PBB", // intra-Public-Bank (subsidiary)
    aliases: ["public islamic"],
  },
  {
    name: "RHB Bank Berhad",
    bic: "RHBBMYKL",
    bnmCode: "18",
    ecpMode: "IBG",
    aliases: ["rhb", "rhb bank"],
  },
  {
    name: "RHB Islamic Bank Berhad",
    bic: "RHBAMYKL",
    bnmCode: "18",
    ecpMode: "IBG",
    aliases: ["rhb islamic"],
  },
  {
    name: "Hong Leong Bank Berhad",
    bic: "HLBBMYKL",
    bnmCode: "24",
    ecpMode: "IBG",
    aliases: ["hong leong", "hlb"],
  },
  {
    name: "Hong Leong Islamic Bank Berhad",
    bic: "HLIBMYKL",
    bnmCode: "24",
    ecpMode: "IBG",
    aliases: ["hong leong islamic"],
  },
  {
    name: "AmBank (M) Berhad",
    bic: "ARBKMYKL",
    bnmCode: "08",
    ecpMode: "IBG",
    aliases: ["ambank", "am bank"],
  },
  {
    name: "AmIslamic Bank (M) Berhad",
    bic: "AISLMYKL",
    bnmCode: "08",
    ecpMode: "IBG",
    aliases: ["ambank islamic", "amislamic"],
  },
  {
    name: "Affin Bank Berhad",
    bic: "PHBMMYKL",
    bnmCode: "32",
    ecpMode: "IBG",
    aliases: ["affin", "affin bank"],
  },
  {
    name: "Affin Islamic Bank Berhad",
    bic: "AIBBMYKL",
    bnmCode: "32",
    ecpMode: "IBG",
    aliases: ["affin islamic"],
  },
  {
    name: "Alliance Bank Malaysia Berhad",
    bic: "MFBBMYKL",
    bnmCode: "12",
    ecpMode: "IBG",
    aliases: ["alliance bank", "alliance"],
  },
  {
    name: "Alliance Islamic Bank Malaysia Berhad",
    bic: "ALSRMYK1",
    bnmCode: "12",
    ecpMode: "IBG",
    aliases: ["alliance islamic"],
  },
  {
    name: "Bank Islam Malaysia Berhad",
    bic: "BIMBMYKL",
    bnmCode: "45",
    ecpMode: "IBG",
    aliases: ["bank islam"],
  },
  {
    name: "Bank Muamalat (Malaysia) Berhad",
    bic: "BMMBMYKL",
    bnmCode: "41",
    ecpMode: "IBG",
    aliases: ["bank muamalat", "muamalat"],
  },
  {
    name: "Bank Rakyat (Bank Kerjasama Rakyat Malaysia Berhad)",
    bic: "BKRMMYKL",
    bnmCode: "02",
    ecpMode: "IBG",
    aliases: ["bank rakyat", "rakyat", "kerjasama rakyat"],
  },
  {
    name: "Bank Simpanan Nasional Berhad",
    bic: "BSNAMYK1",
    bnmCode: "10",
    ecpMode: "IBG",
    aliases: ["bsn", "bank simpanan", "simpanan nasional"],
  },
  {
    name: "Agrobank Berhad",
    bic: "AGOBMYK1",
    bnmCode: "49",
    ecpMode: "IBG",
    aliases: ["agrobank", "agro bank"],
  },
  {
    name: "Al-Rajhi Bank (Malaysia) Berhad",
    bic: "RJHIMYKL",
    bnmCode: "53",
    ecpMode: "IBG",
    aliases: ["al-rajhi", "al rajhi", "rajhi"],
  },
  {
    name: "OCBC Bank (Malaysia) Berhad",
    bic: "OCBCMYKL",
    bnmCode: "29",
    ecpMode: "IBG",
    aliases: ["ocbc"],
  },
  {
    name: "OCBC Al-Amin Bank Berhad",
    bic: "OABBMYKL",
    bnmCode: "29",
    ecpMode: "IBG",
    aliases: ["ocbc al-amin", "al-amin"],
  },
  {
    name: "HSBC Bank Malaysia Berhad",
    bic: "HBMBMYKL",
    bnmCode: "22",
    ecpMode: "IBG",
    aliases: ["hsbc"],
  },
  {
    name: "HSBC Amanah Malaysia Berhad",
    bic: "HMABMYKL",
    bnmCode: "22",
    ecpMode: "IBG",
    aliases: ["hsbc amanah"],
  },
  {
    name: "Standard Chartered Bank (Malaysia) Berhad",
    bic: "SCBLMYKX",
    bnmCode: "14",
    ecpMode: "IBG",
    aliases: ["standard chartered", "scb"],
  },
  {
    name: "Standard Chartered Saadiq (Malaysia) Berhad",
    bic: "SCSRMYK1",
    bnmCode: "14",
    ecpMode: "IBG",
    aliases: ["scb saadiq", "standard chartered saadiq"],
  },
  {
    name: "Citibank Berhad",
    bic: "CITIMYKL",
    bnmCode: "17",
    ecpMode: "IBG",
    aliases: ["citi", "citibank"],
  },
  {
    name: "United Overseas Bank (Malaysia) Berhad",
    bic: "UOVBMYKL",
    bnmCode: "26",
    ecpMode: "IBG",
    aliases: ["uob", "united overseas"],
  },
  {
    name: "MBSB Bank Berhad",
    bic: "AFBQMYKL",
    bnmCode: "75",
    ecpMode: "IBG",
    aliases: ["mbsb"],
  },
  {
    name: "Kuwait Finance House (Malaysia) Berhad",
    bic: "KFHOMYKL",
    bnmCode: "47",
    ecpMode: "IBG",
    aliases: ["kuwait finance", "kfh"],
  },
  {
    name: "Bank of China (Malaysia) Berhad",
    bic: "BKCHMYKL",
    bnmCode: "42",
    ecpMode: "IBG",
    aliases: ["bank of china", "boc"],
  },
  {
    name: "Bank of America (Malaysia) Berhad",
    bic: "BOFAMY2X",
    bnmCode: "07",
    ecpMode: "IBG",
    aliases: ["bank of america", "bofa"],
  },
  {
    name: "Bangkok Bank Berhad",
    bic: "BKKBMYKL",
    bnmCode: "04",
    ecpMode: "IBG",
    aliases: ["bangkok bank"],
  },
  {
    name: "BNP Paribas Malaysia Berhad",
    bic: "BNPAMYKL",
    bnmCode: "60",
    ecpMode: "IBG",
    aliases: ["bnp paribas"],
  },
  {
    name: "China Construction Bank (Malaysia) Berhad",
    bic: "PCBCMYKL",
    bnmCode: "65",
    ecpMode: "IBG",
    aliases: ["china construction", "ccb"],
  },
  {
    name: "Deutsche Bank (Malaysia) Berhad",
    bic: "DEUTMYKL",
    bnmCode: "19",
    ecpMode: "IBG",
    aliases: ["deutsche", "deutsche bank"],
  },
  {
    name: "Industrial and Commercial Bank of China (Malaysia) Berhad",
    bic: "ICBKMYKL",
    bnmCode: "59",
    ecpMode: "IBG",
    aliases: ["icbc", "industrial and commercial"],
  },
  {
    name: "JP Morgan Chase Bank Berhad",
    bic: "CHASMYKX",
    bnmCode: "48",
    ecpMode: "IBG",
    aliases: ["jp morgan", "chase"],
  },
  {
    name: "Mizuho Bank (Malaysia) Berhad",
    bic: "MHCBMYKA",
    bnmCode: "73",
    ecpMode: "IBG",
    aliases: ["mizuho"],
  },
  {
    name: "MUFG Bank (Malaysia) Berhad",
    bic: "BOTKMYKX",
    bnmCode: "52",
    ecpMode: "IBG",
    aliases: ["mufg", "bank of tokyo", "btmu"],
  },
  {
    name: "Sumitomo Mitsui Banking Corporation Malaysia Berhad",
    bic: "SMBCMYKL",
    bnmCode: "51",
    ecpMode: "IBG",
    aliases: ["sumitomo", "smbc"],
  },
]

/**
 * Best-effort match of a free-text bank name to a `MalaysianBank`.
 *
 * Strategy:
 *   1. Lowercase + trim the input.
 *   2. Exact-match against any alias.
 *   3. Substring-match against any alias.
 *   4. Substring-match against the canonical name.
 *
 * Returns `null` when no plausible match is found — the renderer
 * should then surface a clear error rather than guessing.
 */
export function findBankByName(input: string | null | undefined): MalaysianBank | null {
  if (!input) return null
  const needle = input.toLowerCase().trim()
  if (!needle) return null

  // Exact alias hit.
  for (const bank of MALAYSIAN_BANKS) {
    if (bank.aliases.includes(needle)) return bank
  }

  // Substring match — pick the longest alias that the needle contains
  // (avoids `bank islam` snagging the bigger "bank islam malaysia").
  let best: { bank: MalaysianBank; matchLen: number } | null = null
  for (const bank of MALAYSIAN_BANKS) {
    for (const alias of bank.aliases) {
      if (needle.includes(alias) || alias.includes(needle)) {
        const matchLen = Math.min(alias.length, needle.length)
        if (!best || matchLen > best.matchLen) {
          best = { bank, matchLen }
        }
      }
    }
    if (needle.includes(bank.name.toLowerCase())) {
      const matchLen = bank.name.length
      if (!best || matchLen > best.matchLen) {
        best = { bank, matchLen }
      }
    }
  }

  return best?.bank ?? null
}


/**
 * True when the given (free-text) bank name resolves to Public Bank.
 * Drives whether a payroll run offers the PB ECP XLSX (Public Bank) or
 * the general disbursement CSV (any other bank).
 */
export function isPublicBankName(name: string | null | undefined): boolean {
  return findBankByName(name)?.bic === "PBBEMYKL"
}

/// BICs that count as "the company banks with Maybank" for the M2E
/// bulk-payroll file. Maybank Islamic shares the same Maybank2E
/// channel, so both resolve to the same upload format.
const MAYBANK_BICS = new Set(["MBBEMYKL", "MBISMYKL"])

/**
 * True when the given (free-text) bank name resolves to Maybank (or
 * Maybank Islamic). Drives whether a payroll run offers the Maybank
 * M2E payment TXT instead of the general disbursement CSV.
 */
export function isMaybankName(name: string | null | undefined): boolean {
  const bic = findBankByName(name)?.bic
  return bic != null && MAYBANK_BICS.has(bic)
}

/**
 * The banks a company can nominate as its payroll disbursement bank —
 * i.e. the ones we can generate a native bulk-payroll upload file for.
 *
 * This deliberately does NOT constrain where employees bank; every
 * format routes to any Malaysian bank via BIC / BNM code. It only
 * constrains the payor account, because that determines which portal
 * the file is uploaded to.
 */
export const PAYROLL_DISBURSEMENT_BANKS: readonly MalaysianBank[] =
  MALAYSIAN_BANKS.filter((b) => b.payrollFormat != null)

/**
 * Resolve a company's (free-text) payroll bank name to the bulk-payroll
 * file we generate for it. Returns null when the bank has no native
 * format — including for legacy rows that stored a bank we no longer
 * offer, so callers must handle "no file available" rather than
 * assuming one exists.
 */
export function resolvePayrollFileFormat(
  name: string | null | undefined,
): PayrollFileFormat | null {
  return findBankByName(name)?.payrollFormat ?? null
}
