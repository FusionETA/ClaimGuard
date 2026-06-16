import { MapPin } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Compact "lat, lng + Open in Maps" link used on every attendance
 * surface that surfaces captured coordinates (daily activity, employee
 * detail history, off-site log card, etc.). Single source of truth for
 * the Google-Maps URL pattern so we can't drift across surfaces.
 *
 * Renders nothing when either coord is missing — caller doesn't need
 * to guard.
 */
export function CoordsLink({
  lat,
  lng,
  className,
  showCoords = true,
  label = "Open in Maps",
}: {
  lat: number | null | undefined
  lng: number | null | undefined
  className?: string
  /** When false, only the icon + label render (no decimals). */
  showCoords?: boolean
  /** Override the button label — defaults to "Open in Maps". Useful
   *  when context already implies which event the link refers to. */
  label?: string
}) {
  if (lat == null || lng == null) return null
  const url = `https://maps.google.com/?q=${lat},${lng}`
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11px] text-muted-foreground",
        className,
      )}
    >
      {showCoords ? (
        <span className="tabular-nums">
          {lat.toFixed(5)}, {lng.toFixed(5)}
        </span>
      ) : null}
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-0.5 font-semibold text-primary hover:underline"
      >
        <MapPin className="h-3 w-3" />
        {label}
      </a>
    </span>
  )
}
