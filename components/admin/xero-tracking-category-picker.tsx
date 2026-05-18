"use client"

import * as React from "react"
import { useActionState, useId, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Loader2, RefreshCw } from "lucide-react"

import { saveXeroTrackingCategoryAction } from "@/app/(admin)/admin/settings/actions"
import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useToastOnAction } from "@/components/ui/toaster"

/**
 * Single Xero tracking category as surfaced to the picker. Lightweight
 * — only what the dropdown + summary line need. The page-data
 * service does the live read from Xero and shapes this list.
 */
export type XeroTrackingCategoryOption = {
  xeroTrackingCategoryId: string
  name: string
  optionCount: number
}

/**
 * Drives the "which tracking category becomes our Projects" dropdown
 * on the Settings → Projects tab. Lives in its own component so the
 * confirm-on-change dialog and its action wiring don't bloat the
 * already-huge settings panel.
 *
 * Behavior:
 *   - Renders a `<Select>` seeded with the currently-picked id.
 *   - When the admin chooses a different value, we DON'T save yet —
 *     instead we surface a Dialog that spells out the consequences
 *     (legacy projects stay, new sync pulls from the new category,
 *     existing claim/attendance links preserved). Admin must confirm.
 *   - On confirm the dialog submits a hidden form, which routes
 *     through the `saveXeroTrackingCategoryAction` server action.
 *   - Server action validates the ID against Xero before writing, so
 *     stale GUIDs can't slip through.
 */
export function XeroTrackingCategoryPicker(props: {
  connectionId: string
  /// Live-fetched active tracking categories for this connection. May
  /// be empty when the connection has 0 active categories — we show a
  /// helpful empty state in that case.
  categories: XeroTrackingCategoryOption[]
  /// The currently-saved pick (the value stored on XeroConnection).
  /// Pass empty string when nothing is picked yet.
  currentTrackingCategoryId: string
  currentTrackingCategoryName: string | null
  /// Optional message from the page-data service when the live
  /// tracking-categories fetch failed (e.g. expired token). Renders as
  /// an inline error in place of the dropdown.
  loadError?: string
}) {
  const formId = useId()
  const router = useRouter()
  const [refreshPending, startRefresh] = useTransition()
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  // Used as the React key on the <Select>. We bump it whenever the
  // confirmation dialog closes WITHOUT a save (cancel, click-outside,
  // escape) so the Select fully remounts. Reason: Radix's Select
  // tracks the highlighted item internally; if the user picks "B",
  // cancels (controlled value stays "A"), then clicks "B" again,
  // Radix considers it a no-op and doesn't fire onValueChange — so
  // the confirmation dialog never reopens. Remounting wipes that
  // internal state and the next click always registers.
  const [selectKey, setSelectKey] = React.useState(0)
  const [state, action, pending] = useActionState(
    saveXeroTrackingCategoryAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  // Soft re-fetch: tells Next.js to re-run server components for this
  // route, which re-pulls the tracking-categories list from Xero
  // without a hard browser reload. Wrapped in useTransition so we can
  // disable the refresh button while in-flight.
  const handleRefresh = React.useCallback(() => {
    startRefresh(() => {
      router.refresh()
    })
  }, [router])

  // Close dialog automatically after a successful save. Depend on the
  // state reference so back-to-back successes (rare here, but possible
  // if the dialog is reopened without state being reset) re-fire.
  // The lastStatus ref still prevents firing on the initial mount.
  const lastStatus = React.useRef(state.status)
  React.useEffect(() => {
    if (state.status === "success" && lastStatus.current !== "success") {
      setPendingId(null)
    }
    lastStatus.current = state.status
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  const pendingCategory =
    pendingId !== null
      ? props.categories.find((c) => c.xeroTrackingCategoryId === pendingId)
      : null

  if (props.loadError) {
    return (
      <div className="space-y-3 rounded-[20px] border border-rose-200 bg-rose-50/60 p-4 text-sm text-rose-900 dark:border-rose-700/40 dark:bg-rose-950/20 dark:text-rose-200">
        <p>
          Couldn&apos;t read tracking categories from Xero:{" "}
          <span className="font-medium">{props.loadError}</span>
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshPending}
          className="gap-2"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${refreshPending ? "animate-spin" : ""}`}
          />
          {refreshPending ? "Refreshing…" : "Retry"}
        </Button>
      </div>
    )
  }

  if (props.categories.length === 0) {
    return (
      <div className="space-y-3 rounded-[20px] bg-surface-low p-4 text-sm text-muted-foreground">
        <p>
          No active tracking categories found in this Xero org. Create
          a category called{" "}
          <span className="font-medium">Project</span> (or any name you
          prefer) inside Xero, then click Refresh.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshPending}
          className="gap-2"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${refreshPending ? "animate-spin" : ""}`}
          />
          {refreshPending ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-[20px] bg-surface-low p-4">
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">
          Source tracking category
        </p>
        <p className="text-xs text-muted-foreground">
          Each option in the chosen category becomes a project on
          AltomateHR. Xero allows up to 2 active categories per org —
          pick the one that represents your projects.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex-1">
          <Select
            key={selectKey}
            value={props.currentTrackingCategoryId || undefined}
            disabled={pending}
            onValueChange={(v) => {
              // Only open the confirmation when the user is changing
              // to a genuinely different category. Re-selecting the
              // current value is a no-op.
              if (v && v !== props.currentTrackingCategoryId) {
                setPendingId(v)
              }
            }}
          >
            <SelectTrigger className="bg-card">
              <SelectValue placeholder="Pick a tracking category…" />
            </SelectTrigger>
            <SelectContent>
              {props.categories.map((c) => (
                <SelectItem
                  key={c.xeroTrackingCategoryId}
                  value={c.xeroTrackingCategoryId}
                >
                  {c.name} ({c.optionCount} option
                  {c.optionCount === 1 ? "" : "s"})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* Refresh re-fetches the live list of tracking categories
            from Xero without a hard page reload. Useful when the admin
            just created a new category in Xero and wants to see it
            in the dropdown. */}
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={handleRefresh}
          disabled={refreshPending || pending}
          title="Refresh tracking categories from Xero"
          aria-label="Refresh tracking categories from Xero"
        >
          <RefreshCw
            className={`h-4 w-4 ${refreshPending ? "animate-spin" : ""}`}
          />
        </Button>
      </div>

      {props.currentTrackingCategoryName ? (
        <p className="text-xs text-muted-foreground">
          Currently syncing options from{" "}
          <span className="font-medium text-foreground">
            {props.currentTrackingCategoryName}
          </span>
          .
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          No category picked yet — project sync stays paused until you
          choose one.
        </p>
      )}

      <Dialog
        open={pendingId !== null}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setPendingId(null)
            // Force-remount the Select so the next click on the same
            // category we just cancelled out of still fires
            // onValueChange. (See selectKey comment above.)
            setSelectKey((k) => k + 1)
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {props.currentTrackingCategoryId
                ? "Switch tracking category?"
                : "Set tracking category?"}
            </DialogTitle>
            <DialogDescription>
              {props.currentTrackingCategoryId
                ? `Switch from "${
                    props.currentTrackingCategoryName ?? "current"
                  }" to "${pendingCategory?.name ?? ""}"?`
                : `Set "${pendingCategory?.name ?? ""}" as the source for projects?`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">
              Here&apos;s what happens:
            </p>
            <ul className="list-disc space-y-1.5 pl-4">
              <li>
                Projects already synced (including any from before this
                switch) stay in place. Their existing claim and
                attendance links are preserved.
              </li>
              <li>
                The next sync will import options from{" "}
                <span className="font-medium text-foreground">
                  {pendingCategory?.name ?? "the new category"}
                </span>
                {" "}as new projects (
                {pendingCategory?.optionCount ?? 0} option
                {pendingCategory?.optionCount === 1 ? "" : "s"}).
              </li>
              <li>
                Options that match an existing project by name will be
                merged on upsert; new option names become new projects.
              </li>
              <li>
                You can switch back any time — the same rule applies.
              </li>
            </ul>
          </div>

          <form id={formId} action={action} className="contents">
            <input
              type="hidden"
              name="connectionId"
              value={props.connectionId}
            />
            <input
              type="hidden"
              name="xeroTrackingCategoryId"
              value={pendingId ?? ""}
            />
          </form>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              form={formId}
              variant="default"
              disabled={pending}
            >
              {pending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : props.currentTrackingCategoryId ? (
                "Switch category"
              ) : (
                "Set category"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
