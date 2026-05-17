/**
 * Safe error-message helper. Use whenever a caught error is about to
 * be surfaced to a user (toast, FormState message, API error body).
 *
 * Why this exists
 * ───────────────
 * Throughout the action layer the pattern was:
 *
 *   catch (err) {
 *     return { status: "error", message: err instanceof Error ? err.message : "..." }
 *   }
 *
 * That works fine when the THROWER is our own code raising a clean
 * intentional message (e.g. "Project managers must belong to this
 * organization."). But the moment Prisma throws — typically on a
 * unique-constraint violation, a foreign-key violation, or a missing
 * record — the raw Prisma message gets passed straight to the toast.
 * Those messages are noisy ("Unique constraint failed on the fields:
 * (`code`)"), expose schema details (column names, table names), and
 * are confusing for non-technical users.
 *
 * This helper:
 *   1. Recognises Prisma's structured errors (by `.code === "P####"`
 *      and the presence of `.clientVersion`) and maps the common ones
 *      to clean user-facing strings.
 *   2. Recognises Prisma errors by raw message-prefix sniffing too,
 *      since the generated client sometimes throws plain Error objects
 *      with the SQL-flavoured message.
 *   3. For unknown errors, returns the supplied `fallback`. Raw text
 *      from a non-Prisma Error is allowed through ONLY when we've
 *      decided it's safe (heuristic: short, no SQL keywords). Our own
 *      throws are short and clean; Prisma's are long and technical.
 *
 * Server-side, callers should ALSO `console.error(err)` so the raw
 * error stays in the server logs for debugging. This helper only
 * controls what the USER sees.
 */

// Map of Prisma error codes → friendly user-facing string.
// Source: https://www.prisma.io/docs/orm/reference/error-reference
// Only includes the codes that realistically reach an end user.
const PRISMA_FRIENDLY_MESSAGES: Record<string, string> = {
  P2000: "That value is too long for the field.",
  P2001: "Couldn't find the record you were trying to act on.",
  P2002: "That record already exists.",
  P2003: "Can't make this change — another record still depends on it.",
  P2004: "That change would break a database constraint.",
  P2005: "A stored value isn't compatible with the expected format.",
  P2006: "Provided value isn't valid for that field.",
  P2007: "A data validation error occurred.",
  P2011: "A required field was left blank.",
  P2012: "A required field is missing.",
  P2013: "A required argument is missing.",
  P2014: "That change would break a required relationship between records.",
  P2015: "Couldn't find a related record.",
  P2016: "Couldn't resolve the query.",
  P2017: "Records for this relationship aren't connected.",
  P2018: "Couldn't find the connected records.",
  P2019: "Input is invalid.",
  P2020: "A value is out of the allowed range.",
  P2021: "That table doesn't exist in the database.",
  P2022: "That column doesn't exist in the database.",
  P2023: "Stored data is in an inconsistent state.",
  P2024: "The database is busy — please try again.",
  P2025: "Couldn't find the record you were trying to act on.",
  P2026: "The database doesn't support a feature this query uses.",
  P2027: "The database returned multiple errors processing the query.",
  P2034: "The database is busy — please try again.",
}

/**
 * Common substrings that appear in Prisma / SQL error messages but
 * never in our own intentional throws. If we see one of these in an
 * unknown Error's message, we hide it behind the fallback.
 */
const PRISMA_MESSAGE_SIGNATURES = [
  "Unique constraint failed",
  "Foreign key constraint",
  "An operation failed because it depends",
  "Invalid `prisma.",
  "PrismaClientKnownRequestError",
  "PrismaClientUnknownRequestError",
  "PrismaClientValidationError",
  "PrismaClientInitializationError",
  "PrismaClientRustPanicError",
  "Argument ",
  "is missing.",
  "Inconsistent column data",
] as const

/**
 * Extract a Prisma error code (P####) from an arbitrary error object,
 * duck-typed so we don't have to import Prisma's runtime types from
 * the @prisma/client package surface (which moves between versions).
 */
function readPrismaCode(err: unknown): string | null {
  if (err == null || typeof err !== "object") return null
  const maybeCode = (err as { code?: unknown }).code
  if (typeof maybeCode !== "string") return null
  if (!/^P\d{4}$/.test(maybeCode)) return null
  // A real Prisma error also carries clientVersion. The check is
  // belt-and-braces — keeps us from misclassifying a non-Prisma error
  // that happens to have a `code` field that looks Prisma-shaped.
  const maybeVersion = (err as { clientVersion?: unknown }).clientVersion
  if (typeof maybeVersion !== "string") return null
  return maybeCode
}

function looksLikePrismaMessage(message: string): boolean {
  return PRISMA_MESSAGE_SIGNATURES.some((sig) => message.includes(sig))
}

/**
 * Return a user-safe message for the given error.
 *
 *   safeErrorMessage(err, "Unable to save project.")
 *
 * @param err     The caught error. Anything goes — works on Error,
 *                Prisma errors, strings, null, undefined.
 * @param fallback Fallback message when the error is unrecognised or
 *                 unsafe to expose verbatim. Should be specific to the
 *                 calling context (e.g. "Unable to delete account.")
 *                 rather than a generic "Something went wrong."
 */
export function safeErrorMessage(err: unknown, fallback: string): string {
  // Prisma's known structured errors — map the code to a friendly line.
  const code = readPrismaCode(err)
  if (code) {
    return PRISMA_FRIENDLY_MESSAGES[code] ?? fallback
  }

  // Plain Error: trust the message IF it doesn't look like Prisma /
  // SQL technobabble. Our own throws (e.g. "Project managers must
  // belong to this organization.") pass this check; Prisma's verbose
  // messages don't.
  if (err instanceof Error) {
    const msg = err.message?.trim() ?? ""
    if (msg.length === 0) return fallback
    if (looksLikePrismaMessage(msg)) return fallback
    // Cap the length — anything over ~200 chars is almost certainly a
    // stack-y leak we don't want to render.
    if (msg.length > 200) return fallback
    return msg
  }

  // Strings get the same trust-but-verify treatment.
  if (typeof err === "string") {
    if (err.length === 0 || err.length > 200) return fallback
    if (looksLikePrismaMessage(err)) return fallback
    return err
  }

  return fallback
}
