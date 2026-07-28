import { NextRequest, NextResponse } from "next/server"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"

/**
 * GET /uploads/<...path>
 *
 * Streams a file written under `public/uploads/` back to the browser.
 *
 * Why this exists: Next.js only serves files that existed in `public/`
 * at server start. Every upload in this app — claim receipts
 * (`/uploads/receipts/…`), leave attachments
 * (`/uploads/leave-attachments/…`), OT evidence
 * (`/uploads/ot-attachments/…`), attendance selfies — is written at
 * RUNTIME, so the static handler 404s them ("Page not found"). Reading
 * the bytes here and streaming them restores serving for every module
 * at once, without changing how any module stores files or builds its
 * URLs.
 *
 * Auth: intentionally ungated, matching the previous behaviour where
 * these files were served straight from `public/` with no session
 * check. The filenames are unguessable UUIDs. (If we later want to
 * gate receipts behind a session, do it here — but note embedded
 * `<img src>` / new-tab views rely on cookies flowing, which they do
 * for same-origin GETs.)
 */

const UPLOADS_ROOT = path.join(process.cwd(), "public", "uploads")

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".txt": "text/plain; charset=utf-8",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await params

  // Reject empty, traversal, or null-byte segments before touching the
  // filesystem. `decodeURIComponent` first so an encoded "%2e%2e" can't
  // sneak past the check.
  const decoded = segments.map((s) => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  })
  if (
    decoded.length === 0 ||
    decoded.some(
      (s) => s === "" || s === "." || s === ".." || s.includes("\0"),
    )
  ) {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 })
  }

  const absolute = path.join(UPLOADS_ROOT, ...decoded)

  // Defence in depth: the resolved path must still live inside the
  // uploads root. Catches any traversal the segment check missed.
  const normalizedRoot = path.resolve(UPLOADS_ROOT)
  const normalizedTarget = path.resolve(absolute)
  if (
    normalizedTarget !== normalizedRoot &&
    !normalizedTarget.startsWith(normalizedRoot + path.sep)
  ) {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 })
  }

  let bytes: Buffer
  try {
    const info = await stat(normalizedTarget)
    if (!info.isFile()) {
      return NextResponse.json({ error: "Not found." }, { status: 404 })
    }
    bytes = await readFile(normalizedTarget)
  } catch {
    return NextResponse.json({ error: "Not found." }, { status: 404 })
  }

  const ext = path.extname(normalizedTarget).toLowerCase()
  const mimeType = MIME_BY_EXT[ext] ?? "application/octet-stream"

  return new NextResponse(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": mimeType,
      // `inline` so receipts / PDFs render in the tab instead of forcing
      // a download — the user clicked "view receipt", not "download".
      "Content-Disposition": "inline",
      // Uploaded content is immutable (UUID filenames never change), so
      // it's safe to cache aggressively once fetched.
      "Cache-Control": "private, max-age=3600",
    },
  })
}
