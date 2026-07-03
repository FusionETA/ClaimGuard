"use client"

import { Repeat, Star } from "lucide-react"
import { useState, useTransition } from "react"

import { assignShiftToMembershipAction } from "@/app/(employee)/employee/attendance/team/[employeeId]/actions"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useToast } from "@/components/ui/toaster"
import type { SupervisedMembershipShift } from "@/modules/attendance/infrastructure/shift.repository"

const USE_DEFAULT = "__DEFAULT__"

/**
 * Shift-assignment section on the supervisor's employee detail
 * page (Phase 5). Shows one row per team-membership the current
 * supervisor manages that involves the target employee.
 *
 * Each row has a Select — options are the project's shifts plus a
 * "Use project default" entry that clears the override. The picker
 * fires the server action inline (no separate save button) since
 * the change is one field.
 *
 * When the supervisor doesn't manage the target employee in any
 * team, the parent renders nothing (memberships list is empty).
 */
export function ShiftAssignmentPanel({
  employeeId,
  memberships: initial,
}: {
  employeeId: string
  memberships: SupervisedMembershipShift[]
}) {
  if (initial.length === 0) return null

  return (
    <Card className="rounded-2xl">
      <CardContent className="space-y-3 p-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Shift assignment
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Assigns a specific shift for this team member. &quot;Use project
            default&quot; falls back to the shift the admin marked default
            for the project.
          </p>
        </div>

        <ul className="space-y-3">
          {initial.map((m) => (
            <MembershipRow
              key={m.membershipId}
              employeeId={employeeId}
              membership={m}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function MembershipRow({
  employeeId,
  membership,
}: {
  employeeId: string
  membership: SupervisedMembershipShift
}) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [value, setValue] = useState<string>(
    membership.currentShiftId ?? USE_DEFAULT,
  )

  function handleChange(next: string) {
    if (next === value) return
    setValue(next)
    const shiftId = next === USE_DEFAULT ? null : next
    startTransition(async () => {
      const result = await assignShiftToMembershipAction({
        membershipId: membership.membershipId,
        shiftId,
        employeeIdForPath: employeeId,
      })
      if (result.error) {
        // Revert the optimistic UI change on failure — otherwise the
        // dropdown lies about what actually saved.
        setValue(membership.currentShiftId ?? USE_DEFAULT)
        toast({ title: result.error, variant: "error" })
        return
      }
      toast({
        title:
          shiftId === null
            ? `${membership.teamName}: using project default.`
            : `${membership.teamName}: shift updated.`,
      })
    })
  }

  return (
    <li className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            {membership.projectName}
          </p>
          <p className="text-[11px] text-muted-foreground">
            Team: {membership.teamName}
          </p>
        </div>
        {membership.currentShiftIsDefault && membership.currentShiftId ? (
          <Badge variant="approved" className="gap-1 text-[10px]">
            <Star className="h-3 w-3" />
            Default
          </Badge>
        ) : membership.currentShiftId === null ? (
          <Badge variant="outline" className="gap-1 text-[10px]">
            <Repeat className="h-3 w-3" />
            Inheriting default
          </Badge>
        ) : null}
      </div>

      <div className="mt-3">
        <Select
          value={value}
          onValueChange={handleChange}
          disabled={pending || membership.availableShifts.length === 0}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={USE_DEFAULT}>Use project default</SelectItem>
            {membership.availableShifts.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
                <span className="ml-1 text-[10px] text-muted-foreground">
                  {" "}
                  · {s.startTime}–{s.endTime}
                  {s.isDefault ? " · default" : ""}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {membership.availableShifts.length === 0 ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            No shifts defined for {membership.projectName}. Ask an admin to
            add at least one shift on the admin Shifts page first.
          </p>
        ) : null}
      </div>
    </li>
  )
}
