/**
 * Sanitise a string so it survives use as one segment of a filename on
 * Windows, macOS, and Linux. Strips Windows-illegal characters, collapses
 * whitespace to underscores, trims leading/trailing separators, and caps
 * length so long employee names don't blow the 255-char filename limit.
 *
 * Used by every ZIP bundler that names its entries `<Id>_<Name>_<Period>`
 * (bulk payslips, bulk attendance report, bulk leave summary, bulk PCB
 * calculation details).
 */

const FORBIDDEN_FILENAME_CHARS = new Set([
  "<",
  ">",
  ":",
  '"',
  "/",
  "\\",
  "|",
  "?",
  "*",
])

export function sanitiseFilenamePart(raw: string): string {
  let stripped = ""
  for (const ch of raw) {
    if (FORBIDDEN_FILENAME_CHARS.has(ch)) continue
    stripped += ch
  }
  return stripped
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80)
}
