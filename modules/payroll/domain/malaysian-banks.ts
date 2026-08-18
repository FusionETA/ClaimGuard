/**
 * Malaysian bank metadata — name, BIC (Bank Identifier Code), and the
 * Public Bank ECP payment mode (PBB for Public Bank itself, IBG for
 * every other domestic bank routed through Interbank GIRO).
 *
 * Source: BNM IBG members list + Public Bank's published BIC code
 * reference (`pbebank.com > Business Banking > Cash Management`).
 *
 * The bank name keys are kept loose (case-insensitive substring match
 * via `findBankByName`) because the employee `PayrollProfile.bankName`
 * field is free-text — admins may type "Maybank", "MAYBANK BERHAD",
 * "Malayan Banking", etc. The matcher normalises and picks the best
 * fit.
 */

export type EcpPaymentMode = "PBB" | "IBG" | "REN"

export type MalaysianBank = {
  /// Canonical bank name (LHDN / BNM register).
  name: string
  /// Bank Identifier Code (BIC / SWIFT) — required for IBG payments
  /// per the Public Bank ECP spec.
  bic: string
  /// Payment mode for Public Bank ECP. PBB = intra-Public-Bank
  /// (free, instant), IBG = inter-bank GIRO (fee, T+0/T+1).
  ecpMode: EcpPaymentMode
  /// Lower-case aliases used to match against free-text `bankName`
  /// on PayrollProfile. Should include the canonical name itself.
  aliases: readonly string[]
}

export const MALAYSIAN_BANKS: readonly MalaysianBank[] = [
  // Domestic Anchor Banks
  {
    name: "Malayan Banking Berhad",
    bic: "MBBEMYKL",
    ecpMode: "IBG",
    aliases: ["maybank", "malayan banking", "mbb"],
  },
  {
    name: "Maybank Islamic Berhad",
    bic: "MBISMYKL",
    ecpMode: "IBG",
    aliases: ["maybank islamic", "maybank islam"],
  },
  {
    name: "CIMB Bank Berhad",
    bic: "CIBBMYKL",
    ecpMode: "IBG",
    aliases: ["cimb", "cimb bank"],
  },
  {
    name: "CIMB Islamic Bank Berhad",
    bic: "CTBBMYKL",
    ecpMode: "IBG",
    aliases: ["cimb islamic"],
  },
  {
    name: "Public Bank Berhad",
    bic: "PBBEMYKL",
    ecpMode: "PBB", // intra-Public-Bank
    aliases: ["public bank", "pbb", "public bank berhad"],
  },
  {
    name: "Public Islamic Bank Berhad",
    bic: "PIBEMYKL",
    ecpMode: "PBB", // intra-Public-Bank (subsidiary)
    aliases: ["public islamic"],
  },
  {
    name: "RHB Bank Berhad",
    bic: "RHBBMYKL",
    ecpMode: "IBG",
    aliases: ["rhb", "rhb bank"],
  },
  {
    name: "RHB Islamic Bank Berhad",
    bic: "RHBAMYKL",
    ecpMode: "IBG",
    aliases: ["rhb islamic"],
  },
  {
    name: "Hong Leong Bank Berhad",
    bic: "HLBBMYKL",
    ecpMode: "IBG",
    aliases: ["hong leong", "hlb"],
  },
  {
    name: "Hong Leong Islamic Bank Berhad",
    bic: "HLIBMYKL",
    ecpMode: "IBG",
    aliases: ["hong leong islamic"],
  },
  {
    name: "AmBank (M) Berhad",
    bic: "ARBKMYKL",
    ecpMode: "IBG",
    aliases: ["ambank", "am bank"],
  },
  {
    name: "AmIslamic Bank (M) Berhad",
    bic: "AISLMYKL",
    ecpMode: "IBG",
    aliases: ["ambank islamic", "amislamic"],
  },
  {
    name: "Affin Bank Berhad",
    bic: "PHBMMYKL",
    ecpMode: "IBG",
    aliases: ["affin", "affin bank"],
  },
  {
    name: "Affin Islamic Bank Berhad",
    bic: "AIBBMYKL",
    ecpMode: "IBG",
    aliases: ["affin islamic"],
  },
  {
    name: "Alliance Bank Malaysia Berhad",
    bic: "MFBBMYKL",
    ecpMode: "IBG",
    aliases: ["alliance bank", "alliance"],
  },
  {
    name: "Alliance Islamic Bank Malaysia Berhad",
    bic: "ALSRMYK1",
    ecpMode: "IBG",
    aliases: ["alliance islamic"],
  },
  {
    name: "Bank Islam Malaysia Berhad",
    bic: "BIMBMYKL",
    ecpMode: "IBG",
    aliases: ["bank islam"],
  },
  {
    name: "Bank Muamalat (Malaysia) Berhad",
    bic: "BMMBMYKL",
    ecpMode: "IBG",
    aliases: ["bank muamalat", "muamalat"],
  },
  {
    name: "Bank Rakyat (Bank Kerjasama Rakyat Malaysia Berhad)",
    bic: "BKRMMYKL",
    ecpMode: "IBG",
    aliases: ["bank rakyat", "rakyat", "kerjasama rakyat"],
  },
  {
    name: "Bank Simpanan Nasional Berhad",
    bic: "BSNAMYK1",
    ecpMode: "IBG",
    aliases: ["bsn", "bank simpanan", "simpanan nasional"],
  },
  {
    name: "Agrobank Berhad",
    bic: "AGOBMYK1",
    ecpMode: "IBG",
    aliases: ["agrobank", "agro bank"],
  },
  {
    name: "Al-Rajhi Bank (Malaysia) Berhad",
    bic: "RJHIMYKL",
    ecpMode: "IBG",
    aliases: ["al-rajhi", "al rajhi", "rajhi"],
  },
  {
    name: "OCBC Bank (Malaysia) Berhad",
    bic: "OCBCMYKL",
    ecpMode: "IBG",
    aliases: ["ocbc"],
  },
  {
    name: "OCBC Al-Amin Bank Berhad",
    bic: "OABBMYKL",
    ecpMode: "IBG",
    aliases: ["ocbc al-amin", "al-amin"],
  },
  {
    name: "HSBC Bank Malaysia Berhad",
    bic: "HBMBMYKL",
    ecpMode: "IBG",
    aliases: ["hsbc"],
  },
  {
    name: "HSBC Amanah Malaysia Berhad",
    bic: "HMABMYKL",
    ecpMode: "IBG",
    aliases: ["hsbc amanah"],
  },
  {
    name: "Standard Chartered Bank (Malaysia) Berhad",
    bic: "SCBLMYKX",
    ecpMode: "IBG",
    aliases: ["standard chartered", "scb"],
  },
  {
    name: "Standard Chartered Saadiq (Malaysia) Berhad",
    bic: "SCSRMYK1",
    ecpMode: "IBG",
    aliases: ["scb saadiq", "standard chartered saadiq"],
  },
  {
    name: "Citibank Berhad",
    bic: "CITIMYKL",
    ecpMode: "IBG",
    aliases: ["citi", "citibank"],
  },
  {
    name: "United Overseas Bank (Malaysia) Berhad",
    bic: "UOVBMYKL",
    ecpMode: "IBG",
    aliases: ["uob", "united overseas"],
  },
  {
    name: "MBSB Bank Berhad",
    bic: "AFBQMYKL",
    ecpMode: "IBG",
    aliases: ["mbsb"],
  },
  {
    name: "Kuwait Finance House (Malaysia) Berhad",
    bic: "KFHOMYKL",
    ecpMode: "IBG",
    aliases: ["kuwait finance", "kfh"],
  },
  {
    name: "Bank of China (Malaysia) Berhad",
    bic: "BKCHMYKL",
    ecpMode: "IBG",
    aliases: ["bank of china", "boc"],
  },
  {
    name: "Bank of America (Malaysia) Berhad",
    bic: "BOFAMY2X",
    ecpMode: "IBG",
    aliases: ["bank of america", "bofa"],
  },
  {
    name: "Bangkok Bank Berhad",
    bic: "BKKBMYKL",
    ecpMode: "IBG",
    aliases: ["bangkok bank"],
  },
  {
    name: "BNP Paribas Malaysia Berhad",
    bic: "BNPAMYKL",
    ecpMode: "IBG",
    aliases: ["bnp paribas"],
  },
  {
    name: "China Construction Bank (Malaysia) Berhad",
    bic: "PCBCMYKL",
    ecpMode: "IBG",
    aliases: ["china construction", "ccb"],
  },
  {
    name: "Deutsche Bank (Malaysia) Berhad",
    bic: "DEUTMYKL",
    ecpMode: "IBG",
    aliases: ["deutsche", "deutsche bank"],
  },
  {
    name: "Industrial and Commercial Bank of China (Malaysia) Berhad",
    bic: "ICBKMYKL",
    ecpMode: "IBG",
    aliases: ["icbc", "industrial and commercial"],
  },
  {
    name: "JP Morgan Chase Bank Berhad",
    bic: "CHASMYKX",
    ecpMode: "IBG",
    aliases: ["jp morgan", "chase"],
  },
  {
    name: "Mizuho Bank (Malaysia) Berhad",
    bic: "MHCBMYKA",
    ecpMode: "IBG",
    aliases: ["mizuho"],
  },
  {
    name: "MUFG Bank (Malaysia) Berhad",
    bic: "BOTKMYKX",
    ecpMode: "IBG",
    aliases: ["mufg", "bank of tokyo", "btmu"],
  },
  {
    name: "Sumitomo Mitsui Banking Corporation Malaysia Berhad",
    bic: "SMBCMYKL",
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
