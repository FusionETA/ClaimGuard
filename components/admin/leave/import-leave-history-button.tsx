"use client"

import { useState, useTransition, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { Download, Loader2, Upload } from "lucide-react"

import { importLeaveHistoryAction } from "@/app/(admin)/admin/leave/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/toaster"

type RowError = { row: number; message: string }
type ImportResult = {
  balances: { imported: number; failed: number; errors: RowError[] } | null
  history: {
    imported: number
    skipped: number
    failed: number
    errors: RowError[]
  } | null
}

/**
 * "Import leave" dialog on the admin Leave page. Migrates leave from
 * another system via the styled XLSX template's two tabs:
 *   • Leave Balances — the simple path (closing figures only)
 *   • Leave History — optional, full per-application detail
 * Fill either or both; the importer reads whichever tab has data.
 */
export function ImportLeaveHistoryButton() {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ImportResult | null>(null)
  const { toast } = useToast()
  const router = useRouter()

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    startTransition(async () => {
      const res = await importLeaveHistoryAction(fd)
      setResult(res.result ?? null)
      toast({ title: res.message, variant: res.ok ? "success" : "error" })
      if (res.ok) router.refresh()
    })
  }

  const errors: Array<RowError & { tab: string }> = result
    ? [
        ...(result.balances?.errors ?? []).map((e) => ({ ...e, tab: "Balances" })),
        ...(result.history?.errors ?? []).map((e) => ({ ...e, tab: "History" })),
      ]
    : []

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Upload className="h-4 w-4" />
          Import leave
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import leave</DialogTitle>
          <DialogDescription>
            Migrate leave from another system. Use the{" "}
            <span className="font-medium text-foreground">Leave Balances</span>{" "}
            tab for a quick balance migration, or the{" "}
            <span className="font-medium text-foreground">Leave History</span>{" "}
            tab if you also want every past application on record. Fill either
            or both.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4 pl-1">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 p-3 text-sm">
            <div className="space-y-0.5">
              <p className="font-medium text-foreground">Use our Excel template</p>
              <p className="text-xs text-muted-foreground">
                Two tabs — <strong>Leave Balances</strong> (entitled · carry
                forward · taken) and <strong>Leave History</strong>. Your
                leave types are pre-filled as dropdowns.
              </p>
            </div>
            <Button asChild variant="outline" size="sm" className="gap-2">
              <a href="/admin/leave/import-template" download>
                <Download className="h-4 w-4" />
                Download template
              </a>
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="leave-import-file">File (.xlsx or .csv)</Label>
            <input
              id="leave-import-file"
              type="file"
              name="file"
              accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              required
              className="block w-full rounded-md border border-border bg-card px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-primary/10 file:px-3 file:py-1 file:text-xs file:font-medium file:text-primary"
            />
          </div>

          {result ? (
            <div className="space-y-1 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
              {result.balances ? (
                <p className="font-medium text-foreground">
                  Balances — set {result.balances.imported}
                  {result.balances.failed
                    ? ` · ${result.balances.failed} failed`
                    : ""}
                </p>
              ) : null}
              {result.history ? (
                <p className="font-medium text-foreground">
                  History — imported {result.history.imported} · skipped{" "}
                  {result.history.skipped}
                  {result.history.failed
                    ? ` · ${result.history.failed} failed`
                    : ""}
                </p>
              ) : null}
              {errors.slice(0, 8).map((er, i) => (
                <p key={i} className="text-destructive">
                  {er.tab}
                  {er.row > 0 ? ` row ${er.row}` : ""}: {er.message}
                </p>
              ))}
              {errors.length > 8 ? (
                <p className="text-muted-foreground">
                  …and {errors.length - 8} more.
                </p>
              ) : null}
            </div>
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={pending} className="gap-2">
              {pending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Importing…
                </>
              ) : (
                "Import"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
