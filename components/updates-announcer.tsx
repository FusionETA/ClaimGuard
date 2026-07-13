"use client"

import { useEffect, useMemo, useState } from "react"
import { usePathname } from "next/navigation"
import { AlertTriangle, CalendarClock, PartyPopper, Sparkles, X } from "lucide-react"

import {
  RECENTLY_SHIPPED,
  SCHEDULED_MAINTENANCE,
  UPCOMING_FEATURES,
  formatMaintenanceWindow,
  formatMaintenanceWindowCompact,
  getImminentMaintenance,
  matchesAudience,
  type MaintenanceWindow,
  type ShippedFeature,
  type UpcomingFeature,
  type UpdateAudience,
} from "@/lib/updates"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { cn, formatShortDate } from "@/lib/utils"

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
/// Prefixes to suppress the banner + pill on. `startsWith` match, so
/// entries like `/login` also cover `/login/reset`, `/login/verify`, etc.
const EXCLUDED_PREFIXES = ["/maintenance", "/login"]
/// Exact paths to suppress. Kept separate from `EXCLUDED_PREFIXES`
/// because a `startsWith("/")` match would silently hide the pill on
/// every route — the root only needs an exact match.
const EXCLUDED_EXACT = ["/"]

/**
 * Props:
 *   - `audience`: who the current viewer is. Pass `"ADMIN"` for
 *     ADMIN / OWNER sessions, `"EMPLOYEE"` for EMPLOYEE / SUPERVISOR
 *     sessions, and `"ALL"` for logged-out / role-unknown contexts
 *     (the latter just sees `ALL`-tagged entries — the safe default).
 *     The component filters all three arrays + the imminent-window
 *     lookup using `matchesAudience` from `lib/updates.ts`.
 */
export function UpdatesAnnouncer({
  audience = "ALL",
}: {
  audience?: UpdateAudience
} = {}) {
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

  // Audience-filtered slices of the three source arrays. Memoised
  // because `matchesAudience` runs on every entry and we recompute
  // every render — cheap, but no point doing it twice. Sheet reads
  // these straight through.
  const visibleMaintenance = useMemo(
    () => SCHEDULED_MAINTENANCE.filter((w) => matchesAudience(w, audience)),
    [audience],
  )
  const visibleUpcoming = useMemo(
    () => UPCOMING_FEATURES.filter((f) => matchesAudience(f, audience)),
    [audience],
  )
  const visibleShipped = useMemo(
    () => RECENTLY_SHIPPED.filter((f) => matchesAudience(f, audience)),
    [audience],
  )

  const imminent = useMemo<MaintenanceWindow | null>(
    () => getImminentMaintenance(audience),
    // `getImminentMaintenance` reads from the static import; we
    // re-evaluate via the 5-min tick AND when audience changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [audience],
  )

  // Suppress on / (Company Login splash), /login, and /maintenance.
  // The banner / pill add no value on pre-auth or downtime screens
  // and only steal screen real estate.
  const onExcludedPath =
    EXCLUDED_EXACT.includes(pathname ?? "") ||
    EXCLUDED_PREFIXES.some((p) => pathname?.startsWith(p))

  // Nothing visible to this audience? Render nothing — no DOM, no JS work.
  const hasAnyContent =
    visibleMaintenance.length > 0 ||
    visibleUpcoming.length > 0 ||
    visibleShipped.length > 0
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

      <TriggerPill onClick={() => setOpen(true)} hasContent={hasAnyContent} />

      <UpdatesSheet
        open={open}
        onOpenChange={setOpen}
        maintenance={visibleMaintenance}
        upcoming={visibleUpcoming}
        shipped={visibleShipped}
      />
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
        // Position: bottom-LEFT, not bottom-right, so per-page
        // floating action buttons (the + on Claims, Leave, etc.,
        // which all sit bottom-right) never overlap with this pill.
        // Hierarchy stays clean: bottom-right = primary action,
        // bottom-left = passive "what's new" info.
        //
        // On mobile / tablet we sit ABOVE the bottom nav (which lives
        // at `bottom-4` with ~60px height, so `bottom-24` = 96px
        // clears it). On lg+ the bottom nav becomes a sidebar, so
        // we snap to the normal corner.
        "fixed left-4 z-30 bottom-24 lg:bottom-4",
        "inline-flex items-center gap-1.5",
        "rounded-full bg-card/95 px-3 py-1.5 text-xs font-semibold text-foreground",
        "shadow-md ring-1 ring-border/60 backdrop-blur",
        "transition-colors hover:bg-card",
      )}
      aria-label="Open what's new and coming"
    >
      <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
      What&apos;s new
    </button>
  )
}

// ─── Slide-in sheet ──────────────────────────────────────────────────

function UpdatesSheet({
  open,
  onOpenChange,
  maintenance,
  upcoming,
  shipped,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  // Audience-filtered slices from the parent. The sheet renders these
  // verbatim — it never reaches back into the raw `SCHEDULED_MAINTENANCE
  // / UPCOMING_FEATURES / RECENTLY_SHIPPED` imports, so an admin
  // entry can't leak into the employee view.
  maintenance: MaintenanceWindow[]
  upcoming: UpcomingFeature[]
  shipped: ShippedFeature[]
}) {
  // "Show more" toggle for the shipped list. Default: top 3.
  const [showAllShipped, setShowAllShipped] = useState(false)
  const shippedToShow = showAllShipped ? shipped : shipped.slice(0, 3)

  const hasAnyContent =
    maintenance.length > 0 || upcoming.length > 0 || shipped.length > 0

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        // Suppress the default Radix auto-focus on the close × — that
        // was painting a primary focus ring around the icon the moment
        // the sheet opened (it looked like a stray purple circle).
        // The sheet is still keyboard-accessible (Tab → close, Esc to
        // dismiss); we just don't slam focus on the X.
        onOpenAutoFocus={(e) => e.preventDefault()}
        className={cn(
          // Mobile: full screen. Desktop: ~440px right panel.
          "w-full sm:max-w-md",
          // Horizontal padding so the title / X / cards don't hug the
          // edges of the panel; top padding gives the close × room to
          // breathe. The SheetContent primitive itself has no default
          // padding — components own their own gutters.
          "px-5 pt-6 pb-8",
          "overflow-y-auto bg-gradient-to-b from-card via-card to-muted/30",
        )}
      >
        <SheetHeader className="space-y-1.5 pb-3">
          <SheetTitle className="text-2xl">What&apos;s new &amp; coming</SheetTitle>
          <SheetDescription>
            Heads-up on upcoming maintenance and a quick log of features
            we&apos;ve shipped recently.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6 py-4">
          {maintenance.length > 0 ? (
            <Section
              icon={<AlertTriangle className="h-4 w-4 text-amber-600" />}
              title="Scheduled maintenance"
              accentClass="text-amber-700 dark:text-amber-300"
            >
              {maintenance.map((w) => (
                <article
                  key={w.id}
                  className="relative overflow-hidden rounded-2xl border border-amber-200 bg-amber-50/70 p-4 shadow-sm dark:border-amber-800/50 dark:bg-amber-950/30"
                >
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-1 bg-amber-500"
                  />
                  <ClientOnly>
                    <span className="inline-flex items-center rounded-full bg-amber-200/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-900 dark:bg-amber-800/40 dark:text-amber-200">
                      {formatMaintenanceWindow(w)}
                    </span>
                  </ClientOnly>
                  <p className="mt-2 text-sm font-semibold text-foreground">
                    {w.title}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {w.body}
                  </p>
                </article>
              ))}
            </Section>
          ) : null}

          {upcoming.length > 0 ? (
            <Section
              icon={<CalendarClock className="h-4 w-4 text-primary" />}
              title="Coming soon"
              accentClass="text-primary"
            >
              {upcoming.map((f) => (
                <article
                  key={f.id}
                  className="relative overflow-hidden rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm"
                >
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-1 bg-primary"
                  />
                  <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">
                    {f.eta}
                  </span>
                  <p className="mt-2 text-sm font-semibold text-foreground">
                    {f.title}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {f.body}
                  </p>
                </article>
              ))}
            </Section>
          ) : null}

          {shipped.length > 0 ? (
            <Section
              icon={<Sparkles className="h-4 w-4 text-emerald-600" />}
              title="Recently shipped"
              accentClass="text-emerald-700 dark:text-emerald-300"
            >
              <div className="space-y-3">
                {shippedToShow.map((f) => (
                  <article
                    key={f.id}
                    className="relative overflow-hidden rounded-2xl border border-emerald-200/70 bg-emerald-50/40 p-4 shadow-sm transition-colors hover:bg-emerald-50/70 dark:border-emerald-800/40 dark:bg-emerald-950/20 dark:hover:bg-emerald-950/30"
                  >
                    <span
                      aria-hidden
                      className="absolute inset-y-0 left-0 w-1 bg-emerald-500"
                    />
                    <span className="inline-flex items-center rounded-full bg-emerald-200/50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-800 dark:bg-emerald-800/30 dark:text-emerald-200">
                      {formatShortDate(f.date)}
                    </span>
                    <p className="mt-2 text-sm font-semibold text-foreground">
                      {f.title}
                    </p>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      {f.body}
                    </p>
                  </article>
                ))}
              </div>
              {shipped.length > 3 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 w-full text-xs"
                  onClick={() => setShowAllShipped((v) => !v)}
                >
                  {showAllShipped
                    ? "Show less"
                    : `Show ${shipped.length - 3} more`}
                </Button>
              ) : null}
            </Section>
          ) : null}

          {!hasAnyContent ? (
            <div className="rounded-2xl border border-dashed border-border/60 bg-muted/30 p-6 text-center">
              <Sparkles className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">
                Nothing to share right now
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Check back when we ship something new.
              </p>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 pt-2 text-xs text-muted-foreground/80">
              <PartyPopper className="h-3.5 w-3.5" />
              <span>That&apos;s everything for now</span>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Section(props: {
  icon: React.ReactNode
  title: string
  /// Optional Tailwind colour class applied to the title text — gives
  /// each section a different tint so the eye finds the headers fast
  /// (amber maintenance, primary upcoming, emerald shipped). Falls
  /// back to muted-foreground when omitted.
  accentClass?: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <h3
        className={cn(
          "flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em]",
          props.accentClass ?? "text-muted-foreground",
        )}
      >
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
