"use client"

import { useActionState, useEffect, useMemo, useState } from "react"

import {
  createInitialHierarchyFormState,
} from "@/app/(admin)/admin/hierarchy/form-state"
import { updateHierarchyAction } from "@/app/(admin)/admin/hierarchy/actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useToast } from "@/components/ui/toaster"
import type { OrganizationMember } from "@/modules/claims/domain/models"

type AdminHierarchyTableProps = {
  members: OrganizationMember[]
}

export function AdminHierarchyTable({ members }: AdminHierarchyTableProps) {
  const supervisors = members.filter((member) => member.role === "SUPERVISOR")

  return (
    <Card>
      <CardHeader className="p-5 pb-3 sm:p-6 sm:pb-4">
        <CardTitle className="text-xl">Team hierarchy</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Employee</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Project</TableHead>
              <TableHead>Job title</TableHead>
              <TableHead>Supervisor</TableHead>
              <TableHead className="text-right"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <TableRow key={member.id}>
                <TableCell>
                  <div>
                    <p className="font-bold">{member.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {member.email} · {member.employeeId}
                    </p>
                  </div>
                </TableCell>
                <TableCell>{member.role === "SUPERVISOR" ? "Supervisor Employee" : "Basic Employee"}</TableCell>
                <TableCell>{member.project}</TableCell>
                <TableCell>{member.jobTitle}</TableCell>
                <TableCell>{member.supervisorName ?? "No supervisor"}</TableCell>
                <TableCell className="text-right">
                  <HierarchyEditDialog
                    member={member}
                    supervisors={supervisors}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function HierarchyEditDialog({
  member,
  supervisors,
}: {
  member: OrganizationMember
  supervisors: OrganizationMember[]
}) {
  const { toast } = useToast()
  const initialState = useMemo(
    () =>
      createInitialHierarchyFormState({
        role: member.role,
        project: member.project,
        jobTitle: member.jobTitle,
        supervisorId: member.supervisorId ?? "",
      }),
    [member]
  )
  const [state, formAction, pending] = useActionState(updateHierarchyAction, initialState)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (state.status === "success") {
      toast({ title: state.message, variant: "success" })
      setOpen(false)
    }

    if (state.status === "error" && state.message) {
      toast({ title: state.message, variant: "error" })
    }
  }, [state.status, state.message, toast])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="rounded-full">
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:w-[min(92vw,720px)]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Edit hierarchy</DialogTitle>
          <DialogDescription>
            Update {member.name}&apos;s role, project, title, and reporting line.
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="grid gap-4">
          <input type="hidden" name="userId" value={member.id} />
          <input type="hidden" name="email" value={member.email} />

          <div className="rounded-3xl bg-surface-low p-4">
            <p className="font-bold text-foreground">{member.name}</p>
            <p className="text-sm text-muted-foreground">
              {member.email} · {member.employeeId}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-2 text-sm font-semibold text-muted-foreground">
              Role
              <select
                name="role"
                defaultValue={state.values.role}
                disabled={pending}
                className="h-11 w-full rounded-xl border border-transparent bg-surface-low px-4 text-base text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ring-offset-background sm:text-sm"
              >
                <option value="EMPLOYEE">Basic Employee</option>
                <option value="SUPERVISOR">Supervisor Employee</option>
              </select>
            </label>

            <label className="space-y-2 text-sm font-semibold text-muted-foreground">
              Supervisor
              <select
                name="supervisorId"
                defaultValue={state.values.supervisorId}
                disabled={pending}
                className="h-11 w-full rounded-xl border border-transparent bg-surface-low px-4 text-base text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ring-offset-background sm:text-sm"
              >
                <option value="">No supervisor</option>
                {supervisors
                  .filter((supervisor) => supervisor.id !== member.id)
                  .map((supervisor) => (
                    <option key={supervisor.id} value={supervisor.id}>
                      {supervisor.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-2 text-sm font-semibold text-muted-foreground">
              Project
              <Input name="project" defaultValue={state.values.project} disabled={pending} />
            </label>

            <label className="space-y-2 text-sm font-semibold text-muted-foreground">
              Job title
              <Input name="jobTitle" defaultValue={state.values.jobTitle} disabled={pending} />
            </label>
          </div>

          <div className="flex justify-end">
            <Button type="submit" className="rounded-xl" disabled={pending}>
              Save changes
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
