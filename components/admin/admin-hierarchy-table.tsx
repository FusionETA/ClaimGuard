"use client"

import { useActionState, useEffect, useMemo, useState } from "react"

import {
  createInitialAddHierarchyMemberFormState,
  createInitialHierarchyFormState,
} from "@/app/(admin)/admin/hierarchy/form-state"
import {
  createHierarchyMemberAction,
  updateHierarchyAction,
} from "@/app/(admin)/admin/hierarchy/actions"
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
import { PaginationControls } from "@/components/ui/pagination-controls"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useToast } from "@/components/ui/toaster"
import type {
  OrganizationMember,
  OrganizationProjectOption,
  XeroConnectionInfo,
} from "@/modules/organization/domain/models"

type AdminHierarchyTableProps = {
  members: OrganizationMember[]
  projects: OrganizationProjectOption[]
  xeroConnections: XeroConnectionInfo[]
}

const PAGE_SIZE = 10

export function AdminHierarchyTable({ members, projects, xeroConnections }: AdminHierarchyTableProps) {
  const supervisors = members.filter((member) => member.role === "SUPERVISOR")
  const [page, setPage] = useState(1)
  const totalPages = Math.max(1, Math.ceil(members.length / PAGE_SIZE))

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages)
    }
  }, [page, totalPages])

  const paginatedMembers = useMemo(() => {
    const startIndex = (page - 1) * PAGE_SIZE
    return members.slice(startIndex, startIndex + PAGE_SIZE)
  }, [members, page])

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-4 p-5 pb-3 sm:p-6 sm:pb-4">
        <CardTitle className="text-xl">Team hierarchy</CardTitle>
        <AddHierarchyMemberDialog supervisors={supervisors} projects={projects} xeroConnections={xeroConnections} />
      </CardHeader>
      <CardContent className="space-y-4 p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Employee</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Xero org</TableHead>
              <TableHead>Project</TableHead>
              <TableHead>Job title</TableHead>
              <TableHead>Supervisor</TableHead>
              <TableHead className="text-right"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginatedMembers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-12 text-center text-sm text-muted-foreground">
                  No employees yet. Click &ldquo;Add employee&rdquo; to get started.
                </TableCell>
              </TableRow>
            ) : (
              paginatedMembers.map((member) => (
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
                  <TableCell>{member.xeroConnectionName ?? "—"}</TableCell>
                  <TableCell>{member.project || "—"}</TableCell>
                  <TableCell>{member.jobTitle}</TableCell>
                  <TableCell>{member.supervisorName ?? "No supervisor"}</TableCell>
                  <TableCell className="text-right">
                    <HierarchyEditDialog member={member} supervisors={supervisors} projects={projects} xeroConnections={xeroConnections} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        <PaginationControls
          className="flex flex-col gap-3 px-5 pb-5 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:pb-6"
          currentPage={page}
          pageSize={PAGE_SIZE}
          totalItems={members.length}
          itemLabel="members"
          onPageChange={setPage}
        />
      </CardContent>
    </Card>
  )
}

function AddHierarchyMemberDialog({
  supervisors,
  projects,
  xeroConnections,
}: {
  supervisors: OrganizationMember[]
  projects: OrganizationProjectOption[]
  xeroConnections: XeroConnectionInfo[]
}) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [selectedConnectionId, setSelectedConnectionId] = useState("")
  const [state, formAction, pending] = useActionState(
    createHierarchyMemberAction,
    createInitialAddHierarchyMemberFormState()
  )

  const filteredProjects = selectedConnectionId
    ? projects.filter((p) => p.xeroConnectionId === selectedConnectionId)
    : projects

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
        <Button type="button" className="rounded-full">
          Add employee
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:w-[min(92vw,760px)]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Add employee</DialogTitle>
          <DialogDescription>
            Create a new employee or supervisor account inside your organization and assign their reporting details.
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-2 text-sm font-semibold text-muted-foreground">
              Full name
              <Input name="name" defaultValue={state.values.name} disabled={pending} />
            </label>

            <label className="space-y-2 text-sm font-semibold text-muted-foreground">
              Employee ID
              <Input name="employeeId" defaultValue={state.values.employeeId} disabled={pending} />
            </label>

            <label className="space-y-2 text-sm font-semibold text-muted-foreground sm:col-span-2">
              Email
              <Input
                name="email"
                type="email"
                defaultValue={state.values.email}
                disabled={pending}
              />
            </label>

            <label className="space-y-2 text-sm font-semibold text-muted-foreground sm:col-span-2">
              Temporary password
              <Input
                name="password"
                type="password"
                defaultValue={state.values.password}
                disabled={pending}
              />
            </label>

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
              Job title
              <Input name="jobTitle" defaultValue={state.values.jobTitle} disabled={pending} />
            </label>

            {xeroConnections.length > 0 ? (
              <label className="space-y-2 text-sm font-semibold text-muted-foreground sm:col-span-2">
                Xero organization
                <select
                  name="xeroConnectionId"
                  value={selectedConnectionId}
                  onChange={(e) => setSelectedConnectionId(e.target.value)}
                  disabled={pending}
                  className="h-11 w-full rounded-xl border border-transparent bg-surface-low px-4 text-base text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ring-offset-background sm:text-sm"
                >
                  <option value="">No Xero organization</option>
                  {xeroConnections.map((conn) => (
                    <option key={conn.id} value={conn.id}>
                      {conn.tenantName}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {selectedConnectionId ? (
              <label className="space-y-2 text-sm font-semibold text-muted-foreground sm:col-span-2">
                Xero project
                <select
                  name="project"
                  defaultValue={state.values.project}
                  disabled={pending || filteredProjects.length === 0}
                  className="h-11 w-full rounded-xl border border-transparent bg-surface-low px-4 text-base text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ring-offset-background sm:text-sm"
                >
                  <option value="">
                    {filteredProjects.length > 0 ? "No project" : "Sync Xero projects first"}
                  </option>
                  {filteredProjects.map((project) => (
                    <option key={project.id} value={project.name}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="space-y-2 text-sm font-semibold text-muted-foreground sm:col-span-2">
              Supervisor
              <select
                name="supervisorId"
                defaultValue={state.values.supervisorId}
                disabled={pending}
                className="h-11 w-full rounded-xl border border-transparent bg-surface-low px-4 text-base text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ring-offset-background sm:text-sm"
              >
                <option value="">No supervisor</option>
                {supervisors.map((supervisor) => (
                  <option key={supervisor.id} value={supervisor.id}>
                    {supervisor.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex justify-end">
            <Button type="submit" className="rounded-xl" disabled={pending}>
              Create employee
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function HierarchyEditDialog({
  member,
  supervisors,
  projects,
  xeroConnections,
}: {
  member: OrganizationMember
  supervisors: OrganizationMember[]
  projects: OrganizationProjectOption[]
  xeroConnections: XeroConnectionInfo[]
}) {
  const { toast } = useToast()
  const initialState = useMemo(
    () =>
      createInitialHierarchyFormState({
        role: member.role,
        organizationId: member.organizationId ?? "",
        project: member.project,
        jobTitle: member.jobTitle,
        supervisorId: member.supervisorId ?? "",
        xeroConnectionId: member.xeroConnectionId ?? "",
      }),
    [member]
  )
  const [state, formAction, pending] = useActionState(updateHierarchyAction, initialState)
  const [open, setOpen] = useState(false)
  const [selectedConnectionId, setSelectedConnectionId] = useState(member.xeroConnectionId ?? "")

  const filteredProjects = useMemo(() => {
    const baseProjects = selectedConnectionId
      ? projects.filter((p) => p.xeroConnectionId === selectedConnectionId)
      : projects

    // Ensure member's current project appears even if not in filtered list
    if (member.project && !baseProjects.some((p) => p.name === member.project)) {
      return [
        { id: `current-${member.id}`, xeroProjectId: "current", name: member.project },
        ...baseProjects,
      ]
    }

    return baseProjects
  }, [member.id, member.project, projects, selectedConnectionId])

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
              Job title
              <Input name="jobTitle" defaultValue={state.values.jobTitle} disabled={pending} />
            </label>

            {xeroConnections.length > 0 ? (
              <label className="space-y-2 text-sm font-semibold text-muted-foreground">
                Xero organization
                <select
                  name="xeroConnectionId"
                  value={selectedConnectionId}
                  onChange={(e) => setSelectedConnectionId(e.target.value)}
                  disabled={pending}
                  className="h-11 w-full rounded-xl border border-transparent bg-surface-low px-4 text-base text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ring-offset-background sm:text-sm"
                >
                  <option value="">No Xero organization</option>
                  {xeroConnections.map((conn) => (
                    <option key={conn.id} value={conn.id}>
                      {conn.tenantName}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>

          {selectedConnectionId ? (
            <label className="space-y-2 text-sm font-semibold text-muted-foreground">
              Xero project
              <select
                name="project"
                defaultValue={state.values.project}
                disabled={pending || filteredProjects.length === 0}
                className="h-11 w-full rounded-xl border border-transparent bg-surface-low px-4 text-base text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ring-offset-background sm:text-sm"
              >
                <option value="">
                  {filteredProjects.length > 0 ? "No project" : "Sync Xero projects first"}
                </option>
                {filteredProjects.map((project) => (
                  <option key={project.id} value={project.name}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

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
