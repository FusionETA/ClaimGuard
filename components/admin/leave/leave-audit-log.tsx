"use client"

import { useState, useTransition } from "react"
import { Search } from "lucide-react"

import { loadLeaveAuditLogAction } from "@/app/(admin)/admin/leave/audit-actions"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { LeaveAuditEntry } from "@/modules/leave/application/services/leave-overview.service"

type LeaveTypeOption = { id: string; code: string; name: string }

type Status = "ALL" | "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED"

function fmtDate(iso: string): string {
  return iso.slice(0, 10)
}

function statusBadge(status: string): "pending" | "approved" | "rejected" | "outline" {
  if (status === "APPROVED") return "approved"
  if (status === "REJECTED") return "rejected"
  if (status === "PENDING") return "pending"
  return "outline"
}

export function LeaveAuditLog({
  initialRows,
  leaveTypes,
  initialFrom,
  initialTo,
}: {
  initialRows: LeaveAuditEntry[]
  leaveTypes: LeaveTypeOption[]
  initialFrom: string
  initialTo: string
}) {
  const [rows, setRows] = useState(initialRows)
  const [from, setFrom] = useState(initialFrom)
  const [to, setTo] = useState(initialTo)
  const [status, setStatus] = useState<Status>("ALL")
  const [leaveTypeId, setLeaveTypeId] = useState<string>("ALL")
  const [q, setQ] = useState("")
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function refresh() {
    setError(null)
    startTransition(async () => {
      const res = await loadLeaveAuditLogAction({
        from: from || undefined,
        to: to || undefined,
        status,
        leaveTypeId,
        q: q.trim() || undefined,
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      setRows(res.rows)
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit log</CardTitle>
        <p className="text-sm text-muted-foreground">
          Filter leave applications by date, status, type, or employee.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <Label htmlFor="auditFrom">From</Label>
            <Input
              id="auditFrom"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-full"
            />
          </div>
          <div>
            <Label htmlFor="auditTo">To</Label>
            <Input
              id="auditTo"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-full"
            />
          </div>
          <div>
            <Label>Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as Status)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All</SelectItem>
                <SelectItem value="PENDING">Pending</SelectItem>
                <SelectItem value="APPROVED">Approved</SelectItem>
                <SelectItem value="REJECTED">Rejected</SelectItem>
                <SelectItem value="CANCELLED">Cancelled</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Leave type</Label>
            <Select value={leaveTypeId} onValueChange={setLeaveTypeId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All</SelectItem>
                {leaveTypes.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="auditQ">Employee</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="auditQ"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Name or email"
                className="w-full pl-9"
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {pending ? "Loading…" : `${rows.length} row${rows.length === 1 ? "" : "s"}`}
            {error && <span className="ml-2 text-destructive">— {error}</span>}
          </p>
          <button
            type="button"
            onClick={refresh}
            disabled={pending}
            className="rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Apply filters
          </button>
        </div>

        {rows.length === 0 ? (
          <p className="rounded-2xl border border-border/60 bg-surface-low px-4 py-8 text-center text-sm text-muted-foreground">
            No applications match these filters.
          </p>
        ) : (
          <div className="-mx-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Dates</TableHead>
                  <TableHead>Days</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead>Decided</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.employeeName}</TableCell>
                    <TableCell className="font-mono text-xs">{r.leaveTypeCode}</TableCell>
                    <TableCell>
                      {fmtDate(r.startDate)}
                      {r.startDate !== r.endDate && <> → {fmtDate(r.endDate)}</>}
                      {r.duration !== "FULL_DAY" && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          ({r.duration === "MORNING" ? "AM" : "PM"})
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{r.totalDays}</TableCell>
                    <TableCell>
                      <Badge variant={statusBadge(r.status)}>{r.status}</Badge>
                    </TableCell>
                    <TableCell>{fmtDate(r.createdAt)}</TableCell>
                    <TableCell>{r.decidedAt ? fmtDate(r.decidedAt) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
