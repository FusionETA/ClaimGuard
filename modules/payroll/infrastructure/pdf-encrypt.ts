import "server-only"

import { spawn } from "node:child_process"

/**
 * Password-protect a PDF with the `qpdf` CLI (AES-256). `@react-pdf/
 * renderer` produces an unencrypted PDF; this locks it so the file can
 * only be opened with `password`. Used for emailed payslips — an
 * intercepted or forwarded attachment is useless without the employee's
 * secret (their IC number).
 *
 * WHY A CLI, NOT AN NPM MODULE: the native PDF-encryption packages
 * (muhammara/hummus) are node-pre-gyp builds that break Next's Turbopack
 * `next build` (it can't resolve their native binary config). Shelling
 * out to `qpdf` keeps the native tool out of the JS build graph entirely.
 *
 * REQUIREMENT: `qpdf` must be installed on the host — `apt-get install
 * qpdf` (Debian/Ubuntu). If it's missing, this rejects with a clear
 * message and the caller reports the payslip as failed (never sends it
 * unprotected).
 *
 * Reads the source PDF on stdin and writes the encrypted PDF to stdout
 * (`-- - -`), so nothing touches disk.
 */
export function encryptPdf(input: Buffer, password: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "qpdf",
      ["--encrypt", password, password, "256", "--", "-", "-"],
      { stdio: ["pipe", "pipe", "pipe"] },
    )

    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on("data", (d: Buffer) => out.push(d))
    child.stderr.on("data", (d: Buffer) => err.push(d))

    child.on("error", (e) => {
      const code = (e as NodeJS.ErrnoException).code
      reject(
        code === "ENOENT"
          ? new Error(
              "qpdf is not installed on the server (needed to lock the payslip PDF). Run: apt-get install qpdf",
            )
          : e,
      )
    })

    child.on("close", (code) => {
      // qpdf exit codes: 0 = success, 3 = warnings (output still written),
      // 2 = errors. Accept 0 and 3.
      if (code === 0 || code === 3) {
        resolve(Buffer.concat(out))
      } else {
        reject(
          new Error(
            `qpdf failed (exit ${code}): ${Buffer.concat(err).toString().slice(0, 200)}`,
          ),
        )
      }
    })

    // qpdf may exit before we finish writing on a bad input; swallow the
    // resulting EPIPE so it surfaces as the real close-code error above.
    child.stdin.on("error", () => {})
    child.stdin.end(input)
  })
}
