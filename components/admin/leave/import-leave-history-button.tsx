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

type Summary = {
  imported: number
  skipped: number
  failed: number
  errors: Array<{ row: number; message: string }>
}

/**
 * "Import history" dialog on the admin Leave page. Bulk-imports past
 * leave applications from the styled XLSX template (or a CSV) — used when
 * migrating leave from another system. Approved rows count against each
 * employee's balance; a re-upload skips already-imported rows.
 */
export function ImportLeaveHistoryButton() {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [summary, setSummary] = useState<Summary | null>(null)
  const { toast } = useToast()
  const router = useRouter()

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    startTransition(async () => {
      const res = await importLeaveHistoryAction(fd)
      setSummary(res.result ?? null)
      toast({ title: res.message, variant: res.ok ? "success" : "error" })
      if (res.ok) router.refresh()
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Upload className="h-4 w-4" />
          Import history
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import leave history</DialogTitle>
          <DialogDescription>
            Bulk-import past leave applications (e.g. migrating from another
            system). Approved rows count against each employee&apos;s
            balance; set entitlements separately so the remaining balance
            lands right.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4 pl-1">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 p-3 text-sm">
            <div className="space-y-0.5">
              <p className="font-medium text-foreground">Use our Excel template</p>
              <p className="text-xs text-muted-foreground">
                Employee Email · Leave Type · dates · Days · Status. Your
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
            <Label htmlFor="leave-history-file">File (.xlsx or .csv)</Label>
            <input
              id="leave-history-file"
              type="file"
              name="file"
              accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              required
              className="block w-full rounded-md border border-border bg-card px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-primary/10 file:px-3 file:py-1 file:text-xs file:font-medium file:text-primary"
            />
          </div>

          {summary ? (
            <div className="space-y-1 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
              <p className="font-medium text-foreground">
                Imported {summary.imported} · Skipped {summary.skipped} ·
                Failed {summary.failed}
              </p>
              {summary.errors.slice(0, 8).map((er, i) => (
                <p key={i} className="text-destructive">
                  {er.row > 0 ? `Row ${er.row}: ` : ""}
                  {er.message}
                </p>
              ))}
              {summary.errors.length > 8 ? (
                <p className="text-muted-foreground">
                  …and {summary.errors.length - 8} more.
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
