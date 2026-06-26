"use client"

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"

type Props = {
  recordId: string
  /// "clock-in" (default) or "clock-out" — controls which selfie file
  /// the proxy route serves from the attendance record.
  phase?: "clock-in" | "clock-out"
  /// Visible thumbnail size in pixels (square). Ignored when `fill`
  /// is true.
  size?: number
  /// When true, the thumbnail stretches to its parent's height (kept
  /// square via aspect-ratio). Use inside a flex `items-stretch`
  /// container where you want the photo to match adjacent content.
  fill?: boolean
  /// Tailwind classes applied to the thumbnail wrapper. Use this to
  /// adjust border / radius per host context.
  className?: string
  /// Alt text — defaults to "Clock-in selfie".
  alt?: string
}

/// Thumbnail of a clock-in selfie. Click to open a centered lightbox
/// with the full-size image. The image bytes come from the auth-checked
/// /api/attendance/selfie/{recordId} proxy route.
export function SelfieThumbnail({
  recordId,
  phase = "clock-in",
  size = 40,
  fill = false,
  className = "",
  alt,
}: Props) {
  const [open, setOpen] = useState(false)
  const resolvedAlt = alt ?? (phase === "clock-out" ? "Clock-out selfie" : "Clock-in selfie")
  const url =
    phase === "clock-out"
      ? `/api/attendance/selfie/${recordId}?phase=clock-out`
      : `/api/attendance/selfie/${recordId}`

  const sizingClass = fill ? "h-full aspect-square self-stretch" : ""
  const sizingStyle = fill ? undefined : { width: `${size}px`, height: `${size}px` }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`block flex-shrink-0 overflow-hidden rounded-md border border-border/60 bg-muted transition hover:opacity-90 ${sizingClass} ${className}`}
        style={sizingStyle}
        title={resolvedAlt}
        aria-label={resolvedAlt}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={resolvedAlt}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      </button>
      {open ? <Lightbox url={url} alt={resolvedAlt} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function Lightbox({
  url,
  alt,
  onClose,
}: {
  url: string
  alt: string
  onClose: () => void
}) {
  // Portal target — only available client-side.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // ESC closes
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  if (!mounted) return null

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/80 p-4 backdrop-blur-sm"
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
        aria-label="Close"
      >
        <X className="h-5 w-5" />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] max-w-[95vw] rounded-lg object-contain shadow-2xl"
      />
    </div>,
    document.body,
  )
}
