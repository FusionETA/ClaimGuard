"use client"

import { useEffect, useMemo, useState } from "react"
import { usePathname } from "next/navigation"
import { AlertTriangle, CalendarClock, Sparkles, X } from "lucide-react"

import {
  RECENTLY_SHIPPED,
  SCHEDULED_MAINTENANCE,
  UPCOMING_FEATURES,
  formatMaintenanceWindow,
  formatMaintenanceWindowCompact,
  getImminentMaintenance,
  type MaintenanceWindow,
} from "@/lib/updates"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"

/**
 * Top-of-page announcement banner + slide-in updates sheet. Mounted
 * once in `app/layout.tsx` so it appears on every page the layout
 * wraps. Content lives in `lib/updates.ts` — edit that file to
 * publish a new notice; no changes to this component needed.
 *
 * Behaviour:
 *   - Banner renders ONLY when there's a scheduled maintenance entry
 *     starting within `BANNER_LEAD_HOURS` of now AND the user hasn't
 *     dismissed THIS specific entry in the current browser session.
 *   - Banner is the full-width clickable strip. Clicking anywhere
 *     except the × button opens the sheet.
 *   - The sheet shows three sections regardless of whether the banner
 *     fired: scheduled maintenance, upcoming features, recently
 *     shipped. So a user who already dismissed the banner can still
 *     find the info by clicking the floating "What's new" link in
 *     the bottom-right (see `<TriggerPill>` below).
 *   - Dismiss persists in `sessionStorage`, keyed by the maintenance
 *     window's `id`. New window or moved window → new id → banner
 *     reappears even if old one was dismissed.
 *   - Excluded paths (banner + pill suppressed): /maintenance (the
 *     full-page outage page — no point doubling up), /login (don't
 *     distract first-time-visit-of-the-session users from signing in).
 */
const EXCLUDED_PATHS = ["/maintenance", "/login"]

export function UpdatesAnnouncer() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [dismissedId, setDismissedId] = useState<string | null>(null)
  // useState for "now" so the banner doesn't render stale-time text
  // if the tab sat in the background for hours. We poke this every
  // 5 minutes — cheap, and avoids the "still says 2pm tomorrow"
  // problem when the user comes back at 3am.
  const [, setTick] = useState(0)

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("altomate.updates.dismissed")
      if (raw) setDismissedId(raw)
    } catch {
      // sessionStorage can throw in private-mode / cookie-blocked
      // browsers. Banner just stays visible — graceful degradation.
    }
    const interval = setInterval(() => setTick((n) => n + 1), 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  const imminent = useMemo<MaintenanceWindow | null>(
    () => getImminentMaintenance(),
    // Intentionally empty — `getImminentMaintenance` reads from the
    // static import and we re-run via the 5-min tick above. Keeping
    // this hook lightweight matters because it runs on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // Suppress on /maintenance and /login. The banner / pill add no
  // value on those routes and only steal screen real estate.
  const onExcludedPath = EXCLUDED_PATHS.some((p) => pathname?.startsWith(p))

  // Nothing to show at all? Render nothing — no DOM, no JS work.
  const hasAnyContent =
    SCHEDULED_MAINTENANCE.length > 0 ||
    UPCOMING_FEATURES.length > 0 ||
    RECENTLY_SHIPPED.length > 0
  if (onExcludedPath || !hasAnyContent) return null

  const bannerVisible = imminent !== null && imminent.id !== dismissedId

  function dismissBanner(id: string) {
    setDismissedId(id)
    try {
      sessionStorage.setItem("altomate.updates.dismissed", id)
    } catch {
      // Ignore — banner will just reappear next page load, no harm.
    }
  }

  return (
    <>
      {bannerVisible && imminent ? (
        <MaintenanceBanner
          window={imminent}
          onOpen={() => setOpen(true)}
          onDismiss={() => dismissBanner(imminent.id)}
        />
      ) : null}

      <TriggerPill
        onClick={() => setOpen(true)}
        hasContent={
          SCHEDULED_MAINTENANCE.length > 0 ||
          UPCOMING_FEATURES.length > 0 ||
          RECENTLY_SHIPPED.length > 0
        }
      />

      <UpdatesSheet open={open} onOpenChange={setOpen} />
    </>
  )
}

// ─── Banner ──────────────────────────────────────────────────────────

function MaintenanceBanner({
  window,
  onOpen,
  onDismiss,
}: {
  window: MaintenanceWindow
  onOpen: () => void
  onDismiss: () => void
}) {
  // Hydration-safe: on SSR we can't know the user's timezone, so we
  // render a stable placeholder and swap to the formatted time on the
  // client. Prevents the React hydration warning.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group block w-full bg-amber-100/95 px-3 py-2 text-left text-amber-950 transition-colors hover:bg-amber-200/90",
        "border-b border-amber-300/70 dark:bg-amber-950/40 dark:text-amber-100 dark:border-amber-700/40 dark:hover:bg-amber-950/60",
      )}
      aria-label="Open scheduled maintenance details"
    >
      <div className="mx-auto flex max-w-7xl items-center gap-2 sm:gap-3">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
        <p className="flex-1 text-xs leading-5 sm:text-sm">
          {/* Mobile-compact wording — short enough to fit on a phone */}
          <span className="sm:hidden">
            <span className="font-semibold">Maintenance{" "}
              {mounted ? formatMaintenanceWindowCompact(window) : "soon"}
            </span>{" "}
            · tap for details
          </span>
          {/* Desktop wording — full date/time range, full sentence */}
          <span className="hidden sm:inline">
            <span className="font-semibold">Scheduled maintenance:</span>{" "}
            {mounted ? formatMaintenanceWindow(window) : "soon"}. Click for
            what's coming.
          </span>
        </p>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation()
            onDismiss()
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation()
              onDismiss()
            }
          }}
          className={cn(
            "ml-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
            "text-amber-900/70 transition-colors hover:bg-amber-300/40 hover:text-amber-950",
            "dark:text-amber-200/70 dark:hover:bg-amber-800/40 dark:hover:text-amber-100",
            "sm:h-6 sm:w-6",
          )}
          aria-label="Dismiss this banner for the current session"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </span>
      </div>
    </button>
  )
}

// ─── Floating trigger pill (always available) ─────────────────────────

/**
 * A small floating "What's new" pill in the bottom-right corner.
 * Lets users open the sheet even after they've dismissed the banner,
 * AND surfaces upcoming features / recent ships even when no
 * maintenance is imminent. Subtle by design — doesn't compete with
 * the page CTA.
 */
function TriggerPill({
  onClick,
  hasContent,
}: {
  onClick: () => void
  hasContent: boolean
}) {
  if (!hasContent) return null
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "fixed bottom-4 right-4 z-40 inline-flex items-center gap-1.5",
        "rounded-full bg-foreground/5 px-3 py-1.5 text-xs font-medium text-foreground",
        "shadow-sm ring-1 ring-border/60 backdrop-blur",
        "transition-colors hover:bg-foreground/10",
        // Hide on very small screens — the banner already covers that
        // case, and the pill would overlap with the mobile bottom nav.
        "hidden sm:inline-flex",
      )}
      aria-label="Open what's new and coming"
    >
      <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
      What's new
    </button>
  )
}

// ─── Slide-in sheet ──────────────────────────────────────────────────

function UpdatesSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  // "Show more" toggle for the shipped list. Default: top 3.
  const [showAllShipped, setShowAllShipped] = useState(false)
  const shippedToShow = showAllShipped
    ? RECENTLY_SHIPPED
    : RECENTLY_SHIPPED.slice(0, 3)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn(
          // Mobile: full screen. Desktop: ~440px right panel.
          "w-full sm:max-w-md",
          "overflow-y-auto bg-card",
        )}
      >
        <SheetHeader className="space-y-1 pb-2">
          <SheetTitle>What's new &amp; coming</SheetTitle>
          <SheetDescription>
            Heads-up on upcoming maintenance and a quick log of features
            we&apos;ve shipped recently.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6 py-4">
          {SCHEDULED_MAINTENANCE.length > 0 ? (
            <Section
              icon={<AlertTriangle className="h-4 w-4 text-amber-600" />}
              title="Scheduled maintenance"
            >
              {SCHEDULED_MAINTENANCE.map((w) => (
                <article
                  key={w.id}
                  className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-800/50 dark:bg-amber-950/30"
                >
                  <ClientOnly>
                    <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">
                      {formatMaintenanceWindow(w)}
                    </p>
                  </ClientOnly>
                  <p className="mt-1 text-sm font-medium text-foreground">
                    {w.title}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {w.body}
                  </p>
                </article>
              ))}
            </Section>
          ) : null}

          {UPCOMING_FEATURES.length > 0 ? (
            <Section
              icon={<CalendarClock className="h-4 w-4 text-primary" />}
              title="Coming soon"
            >
              {UPCOMING_FEATURES.map((f) => (
                <article
                  key={f.id}
                  className="rounded-xl border border-border/60 bg-muted/40 p-3"
                >
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">
                    {f.eta}
                  </p>
                  <p className="mt-1 text-sm font-medium text-foreground">
                    {f.title}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {f.body}
                  </p>
                </article>
              ))}
            </Section>
          ) : null}

          {RECENTLY_SHIPPED.length > 0 ? (
            <Section
              icon={<Sparkles className="h-4 w-4 text-emerald-600" />}
              title="Recently shipped"
            >
              <div className="space-y-2.5">
                {shippedToShow.map((f) => (
                  <article
                    key={f.id}
                    className="rounded-xl border border-border/60 bg-card p-3"
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {f.date}
                    </p>
                    <p className="mt-1 text-sm font-medium text-foreground">
                      {f.title}
                    </p>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      {f.body}
                    </p>
                  </article>
                ))}
              </div>
              {RECENTLY_SHIPPED.length > 3 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 w-full text-xs"
                  onClick={() => setShowAllShipped((v) => !v)}
                >
                  {showAllShipped
                    ? "Show less"
                    : `Show ${RECENTLY_SHIPPED.length - 3} more`}
                </Button>
              ) : null}
            </Section>
          ) : null}

          {/* Empty-state safety net — shouldn't normally reach this
              branch because the parent already filters by hasContent,
              but cheap to render and useful if someone empties one
              array without checking the others. */}
          {SCHEDULED_MAINTENANCE.length === 0 &&
          UPCOMING_FEATURES.length === 0 &&
          RECENTLY_SHIPPED.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing to share right now. Check back soon.
            </p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Section(props: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {props.icon}
        {props.title}
      </h3>
      <div className="space-y-2.5">{props.children}</div>
    </section>
  )
}

/**
 * Wraps children so they only render after the first client paint —
 * needed for any node that uses the browser timezone (e.g., date
 * formatters), to dodge React's hydration warning when the SSR
 * output doesn't match.
 */
function ClientOnly({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null
  return <>{children}</>
}
