import "server-only"

import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/**
 * Password-protect a PDF with the `qpdf` CLI (AES-256). `@react-pdf/
 * renderer` produces an unencrypted PDF; this locks it so the file can
 * only be opened with `password`. Used for emailed payslips — an
 * intercepted or forwarded attachment is useless without the employee's
 * secret (their IC number).
 *
 * WHY A CLI, NOT AN NPM MODULE: the native PDF-encryption packages
 * (muhammara/hummus) are node-pre-gyp builds that break Next's Turbopack
 * `next build`. Shelling out to `qpdf` keeps the native tool out of the
 * JS build graph entirely. REQUIREMENT: `qpdf` must be installed on the
 * host (`apt-get install qpdf`).
 *
 * WHY TEMP FILES, NOT STDIN/STDOUT: qpdf can't reliably process a PDF over
 * a pipe — it needs a SEEKABLE input to read the xref/trailer, and many
 * builds treat `-` as a literal filename (failing with
 * "qpdf: open -: No such file or directory"). So we stage the PDF in a
 * private temp dir, encrypt file→file, read it back, and delete the dir.
 */
export async function encryptPdf(input: Buffer, password: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "payslip-"))
  const inPath = join(dir, "in.pdf")
  const outPath = join(dir, "out.pdf")
  try {
    await writeFile(inPath, input)

    try {
      // qpdf --encrypt <user-pw> <owner-pw> <bits> -- <infile> <outfile>
      await execFileAsync("qpdf", [
        "--encrypt",
        password,
        password,
        "256",
        "--",
        inPath,
        outPath,
      ])
    } catch (e) {
      // promisified execFile rejects with `code` = exit number on a
      // non-zero exit, or "ENOENT" (string) when the binary is missing.
      const err = e as { code?: number | string; stderr?: string; message?: string }
      if (err.code === "ENOENT") {
        throw new Error(
          "qpdf is not installed on the server (needed to lock the payslip PDF). Run: apt-get install qpdf",
        )
      }
      // qpdf exit codes: 0 = success, 3 = warnings (output STILL written),
      // 2 = errors. Only 3 is safe to continue past.
      if (err.code !== 3) {
        const detail = (err.stderr || err.message || "").trim().slice(0, 200)
        throw new Error(`qpdf failed (exit ${err.code}): ${detail}`)
      }
    }

    return await readFile(outPath)
  } finally {
    // Best-effort cleanup — never leave a decrypted-or-encrypted payslip
    // on disk after the send.
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
