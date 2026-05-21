import Link from "next/link"
import type { Route } from "next"
import { CalendarDays } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { OnLeaveTodayEntry } from "@/modules/leave/application/services/leave-overview.service"

function fmtDate(iso: string): string {
  return iso.slice(0, 10)
}

export function OnLeaveTodayCard({ entries }: { entries: OnLeaveTodayEntry[] }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          <CardTitle>On leave today</CardTitle>
        </div>
        <Link
          href={"/admin/leave" as Route}
          className="text-xs font-bold text-primary hover:underline"
        >
          View all →
        </Link>
      </CardHeader>
      <CardContent className="p-0">
        {entries.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-muted-foreground">
            No one is on leave today.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Dates</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={`${e.employeeId}-${e.startDate}`}>
                  <TableCell className="font-medium">{e.employeeName}</TableCell>
                  <TableCell>{e.leaveTypeName}</TableCell>
                  <TableCell>
                    {fmtDate(e.startDate)}
                    {e.startDate !== e.endDate && <> → {fmtDate(e.endDate)}</>}
                    {e.duration !== "FULL_DAY" && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({e.duration === "MORNING" ? "AM" : "PM"})
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
