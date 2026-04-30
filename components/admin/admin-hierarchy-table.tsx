"use client"

import { useActionState, useEffect, useMemo, useState, useTransition } from "react"

import {
  createInitialAddHierarchyMemberFormState,
  createInitialHierarchyFormState,
} from "@/app/(admin)/admin/hierarchy/form-state"
import {
  createHierarchyMemberAction,
  saveApprovalChainAction,
  updateHierarchyAction,
} from "@/app/(admin)/admin/hierarchy/actions"
import { Loader2, Plus, Search, X } from "lucide-react"

function ordinalLabel(n: number) {
  const s = ["th", "st", "nd", "rd"]
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0]) + " Supervisor"
}

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
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
  organizationName: string
}

type RoleFilter = "ALL" | "EMPLOYEE" | "SUPERVISOR"

const PAGE_SIZE = 10

const roleLabels: Record<Exclude<RoleFilter, "ALL">, string> = {
  EMPLOYEE: "Basic Employee",
  SUPERVISOR: "Supervisor Employee",
}

const roleOptions: Exclude<RoleFilter, "ALL">[] = ["EMPLOYEE", "SUPERVISOR"]

function getDirectSupervisor(member: OrganizationMember) {
  return member.approvalChain[0]?.approverName ?? member.supervisorName ?? null
}

export function AdminHierarchyTable({
  members,
  projects,
  xeroConnections,
  organizationName,
}: AdminHierarchyTableProps) {
  const supervisors = members.filter((member) => member.role === "SUPERVISOR")
  const [page, setPage] = useState(1)
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("ALL")
  const [searchTerm, setSearchTerm] = useState("")

  // One company connects to at most one Xero tenant. Use the first connection if any.
  const xeroConnection = xeroConnections[0]
  const xeroDisplayName = xeroConnection?.tenantName ?? organizationName

  const filteredMembers = useMemo(() => {
    const normalizedQuery = searchTerm.trim().toLowerCase()

    return members.filter((member) => {
      const matchesRole = roleFilter === "ALL" ? true : member.role === roleFilter

      const matchesQuery =
        normalizedQuery.length === 0
          ? true
          : [
              member.name,
              member.email,
              member.employeeId,
              member.jobTitle,
              member.project,
              getDirectSupervisor(member),
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(normalizedQuery)

      return matchesRole && matchesQuery
    })
  }, [members, roleFilter, searchTerm])

  useEffect(() => {
    setPage(1)
  }, [roleFilter, searchTerm])

  const totalPages = Math.max(1, Math.ceil(filteredMembers.length / PAGE_SIZE))

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages)
    }
  }, [page, totalPages])

  const paginatedMembers = useMemo(() => {
    const startIndex = (page - 1) * PAGE_SIZE
    return filteredMembers.slice(startIndex, startIndex + PAGE_SIZE)
  }, [filteredMembers, page])

  const hasActiveFilters = roleFilter !== "ALL" || searchTerm.trim().length > 0

  return (
    <div className="space-y-4 sm:space-y-6">
      <Card>
        <CardContent className="space-y-4 px-5 pb-5 pt-3 sm:space-y-5 sm:p-6">
          <div className="hidden items-center justify-between gap-4 md:flex">
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search by name, email, ID, project, or supervisor"
                className="pl-10"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant={roleFilter === "ALL" ? "default" : "ghost"}
                onClick={() => setRoleFilter("ALL")}
                className={cn(
                  "rounded-full",
                  roleFilter !== "ALL" &&
                    "bg-surface-low text-muted-foreground hover:bg-surface-high hover:text-foreground"
                )}
              >
                All
              </Button>
              {roleOptions.map((role) => (
                <Button
                  key={role}
                  type="button"
                  size="sm"
                  variant={roleFilter === role ? "default" : "ghost"}
                  onClick={() => setRoleFilter(role)}
                  className={cn(
                    "rounded-full",
                    roleFilter !== role &&
                      "bg-surface-low text-muted-foreground hover:bg-surface-high hover:text-foreground"
                  )}
                >
                  {roleLabels[role]}
                </Button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 md:hidden">
            <button
              type="button"
              onClick={() => setRoleFilter("ALL")}
              className={cn(
                "relative z-10 touch-manipulation rounded-[20px] px-4 py-3 text-sm font-semibold transition-all sm:text-base",
                roleFilter === "ALL"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-surface-low hover:text-foreground"
              )}
            >
              All
            </button>
            {roleOptions.map((role) => (
              <button
                key={role}
                type="button"
                onClick={() => setRoleFilter(role)}
                className={cn(
                  "relative z-10 touch-manipulation rounded-[20px] px-4 py-3 text-sm font-semibold transition-all sm:text-base",
                  roleFilter === role
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-surface-low hover:text-foreground"
                )}
              >
                {roleLabels[role]}
              </button>
            ))}
          </div>

          <div className="md:hidden">
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search team"
                className="pl-10"
              />
            </div>
          </div>

          <div className="hidden flex-col gap-2 text-sm text-muted-foreground md:flex md:flex-row md:items-center md:justify-between">
            <p>
              Showing <span className="font-semibold text-foreground">{filteredMembers.length}</span>{" "}
              of <span className="font-semibold text-foreground">{members.length}</span> employees
            </p>
            {hasActiveFilters && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-fit rounded-full"
                onClick={() => {
                  setRoleFilter("ALL")
                  setSearchTerm("")
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="px-1 text-sm text-muted-foreground md:hidden">
        <p>
          Showing <span className="font-semibold text-foreground">{filteredMembers.length}</span> of{" "}
          <span className="font-semibold text-foreground">{members.length}</span> employees
        </p>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4 p-5 pb-3 sm:p-6 sm:pb-4">
          <CardTitle className="text-xl">Team hierarchy</CardTitle>
          <AddHierarchyMemberDialog
            supervisors={supervisors}
            projects={projects}
            xeroConnection={xeroConnection}
            xeroDisplayName={xeroDisplayName}
          />
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
                    {hasActiveFilters
                      ? "No employees match the selected filters."
                      : "No employees yet. Click “Add employee” to get started."}
                  </TableCell>
                </TableRow>
              ) : (
                paginatedMembers.map((member) => {
                  const directSupervisor = getDirectSupervisor(member)
                  return (
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
                      <TableCell>
                        <div>
                          <p>{directSupervisor ?? "No supervisor"}</p>
                          {member.approvalChain.length > 1 ? (
                            <p className="text-xs text-muted-foreground">
                              {member.approvalChain.length}-step chain
                            </p>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <HierarchyEditDialog
                          member={member}
                          supervisors={supervisors}
                          projects={projects}
                          xeroConnection={xeroConnection}
                          xeroDisplayName={xeroDisplayName}
                        />
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>

          <PaginationControls
            className="flex flex-col gap-3 px-5 pb-5 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:pb-6"
            currentPage={page}
            pageSize={PAGE_SIZE}
            totalItems={filteredMembers.length}
            itemLabel="members"
            onPageChange={setPage}
          />
        </CardContent>
      </Card>
    </div>
  )
}

function AddHierarchyMemberDialog({
  supervisors,
  projects,
  xeroConnection,
  xeroDisplayName,
}: {
  supervisors: OrganizationMember[]
  projects: OrganizationProjectOption[]
  xeroConnection: XeroConnectionInfo | undefined
  xeroDisplayName: string
}) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [chainApproverIds, setChainApproverIds] = useState<string[]>([])
  const [addProjectValue, setAddProjectValue] = useState("")
  const [state, formAction, pending] = useActionState(
    createHierarchyMemberAction,
    createInitialAddHierarchyMemberFormState()
  )

  const xeroConnectionId = xeroConnection?.id ?? ""
  const filteredProjects = xeroConnectionId
    ? projects.filter((p) => p.xeroConnectionId === xeroConnectionId)
    : projects

  useEffect(() => {
    if (state.status === "success") {
      toast({ title: state.message, variant: "success" })
      setOpen(false)
      setChainApproverIds([])
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

            <div className="space-y-2 text-sm font-semibold text-muted-foreground">
              <label htmlFor="add-role">Role</label>
              <Select name="role" defaultValue={state.values.role || "EMPLOYEE"} disabled={pending}>
                <SelectTrigger id="add-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="EMPLOYEE">Basic Employee</SelectItem>
                  <SelectItem value="SUPERVISOR">Supervisor Employee</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <label className="space-y-2 text-sm font-semibold text-muted-foreground">
              Job title
              <Input name="jobTitle" defaultValue={state.values.jobTitle} disabled={pending} />
            </label>

            <div className="space-y-2 text-sm font-semibold text-muted-foreground sm:col-span-2">
              Xero organization
              <input type="hidden" name="xeroConnectionId" value={xeroConnectionId} />
              <div className="flex h-12 w-full items-center rounded-2xl border border-border/80 bg-card px-4 text-base text-foreground shadow-sm sm:h-11 sm:text-sm">
                {xeroDisplayName || "—"}
              </div>
            </div>

            {xeroConnectionId ? (
              <div className="space-y-2 text-sm font-semibold text-muted-foreground sm:col-span-2">
                <label htmlFor="add-project">Xero project</label>
                <input type="hidden" name="project" value={addProjectValue} />
                <Select
                  value={addProjectValue || "__none"}
                  onValueChange={(v) => setAddProjectValue(v === "__none" ? "" : v)}
                  disabled={pending || filteredProjects.length === 0}
                >
                  <SelectTrigger id="add-project">
                    <SelectValue
                      placeholder={filteredProjects.length > 0 ? "No project" : "Sync Xero projects first"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">No project</SelectItem>
                    {filteredProjects.map((project) => (
                      <SelectItem key={project.id} value={project.name}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {/* Hidden inputs carry the chain approver IDs to the server action */}
            {chainApproverIds.map((id, i) => (
              <input key={i} type="hidden" name="approverIds" value={id} />
            ))}

            <div className="space-y-2 sm:col-span-2">
              <p className="text-sm font-semibold text-muted-foreground">Approval chain</p>
              {supervisors.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No supervisors yet — add supervisors first to build an approval chain.
                </p>
              ) : (
                <>
                  {chainApproverIds.map((approverId, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <span className="shrink-0 w-28 text-xs font-semibold text-muted-foreground">
                        {ordinalLabel(index + 1)}
                      </span>
                      <div className="flex-1">
                        <Select
                          value={approverId || undefined}
                          onValueChange={(v) =>
                            setChainApproverIds((prev) =>
                              prev.map((id, i) => (i === index ? v : id))
                            )
                          }
                          disabled={pending}
                        >
                          <SelectTrigger className="h-10">
                            <SelectValue placeholder="Select supervisor…" />
                          </SelectTrigger>
                          <SelectContent>
                            {supervisors.map((s) => (
                              <SelectItem
                                key={s.id}
                                value={s.id}
                                disabled={chainApproverIds.some((id, i) => id === s.id && i !== index)}
                              >
                                {s.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setChainApproverIds((prev) => prev.filter((_, i) => i !== index))
                        }
                        disabled={pending}
                        className="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-xl"
                    onClick={() => setChainApproverIds((prev) => [...prev, ""])}
                    disabled={pending || chainApproverIds.length >= supervisors.length}
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    Add supervisor
                  </Button>
                </>
              )}
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              type="submit"
              className="rounded-xl"
              disabled={pending || chainApproverIds.some((id) => !id)}
            >
              {pending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Creating…</> : "Create employee"}
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
  xeroConnection,
  xeroDisplayName,
}: {
  member: OrganizationMember
  supervisors: OrganizationMember[]
  projects: OrganizationProjectOption[]
  xeroConnection: XeroConnectionInfo | undefined
  xeroDisplayName: string
}) {
  const { toast } = useToast()
  const xeroConnectionId = xeroConnection?.id ?? ""
  const initialState = useMemo(
    () =>
      createInitialHierarchyFormState({
        role: member.role,
        organizationId: member.organizationId ?? "",
        project: member.project,
        jobTitle: member.jobTitle,
        supervisorId: member.supervisorId ?? "",
        xeroConnectionId,
      }),
    [member, xeroConnectionId]
  )
  const [state, formAction, pending] = useActionState(updateHierarchyAction, initialState)
  const [open, setOpen] = useState(false)
  const [editProjectValue, setEditProjectValue] = useState(member.project ?? "")

  // Approval chain state — initialised from the member's existing chain
  const [chainApproverIds, setChainApproverIds] = useState<string[]>(
    () => member.approvalChain.map((s) => s.approverId)
  )
  const [chainPending, startChainTransition] = useTransition()

  const filteredProjects = useMemo(() => {
    const baseProjects = xeroConnectionId
      ? projects.filter((p) => p.xeroConnectionId === xeroConnectionId)
      : projects

    if (member.project && !baseProjects.some((p) => p.name === member.project)) {
      return [
        { id: `current-${member.id}`, xeroProjectId: "current", name: member.project },
        ...baseProjects,
      ]
    }

    return baseProjects
  }, [member.id, member.project, projects, xeroConnectionId])

  useEffect(() => {
    if (state.status === "success") {
      toast({ title: state.message, variant: "success" })
      setOpen(false)
    }

    if (state.status === "error" && state.message) {
      toast({ title: state.message, variant: "error" })
    }
  }, [state.status, state.message, toast])

  // Reset chain when dialog opens/member changes
  useEffect(() => {
    if (open) {
      setChainApproverIds(member.approvalChain.map((s) => s.approverId))
    }
  }, [open, member.approvalChain])

  function handleAddChainStep() {
    setChainApproverIds((prev) => [...prev, ""])
  }

  function handleChainApproverChange(index: number, approverId: string) {
    setChainApproverIds((prev) => prev.map((id, i) => (i === index ? approverId : id)))
  }

  function handleRemoveChainStep(index: number) {
    setChainApproverIds((prev) => prev.filter((_, i) => i !== index))
  }

  function handleSaveChain() {
    const validIds = chainApproverIds.filter(Boolean)
    startChainTransition(async () => {
      const result = await saveApprovalChainAction(member.id, validIds)
      if (result.ok) {
        toast({ title: result.message, variant: "success" })
      } else {
        toast({ title: result.message, variant: "error" })
      }
    })
  }

  // Approver candidates: supervisors, excluding the member themselves
  const approverOptions = supervisors.filter((s) => s.id !== member.id)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="rounded-full">
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:w-[min(92vw,720px)] max-h-[90vh] overflow-y-auto"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Edit hierarchy</DialogTitle>
          <DialogDescription>
            Update {member.name}&apos;s role, project, title, and approval chain.
          </DialogDescription>
        </DialogHeader>

        {/* ── Role / project / title form ─────────────────────────────────── */}
        <form action={formAction} className="grid gap-4">
          <input type="hidden" name="userId" value={member.id} />
          <input type="hidden" name="email" value={member.email} />

          <div className="rounded-3xl bg-surface-low p-4">
            <p className="font-bold text-foreground">{member.name}</p>
            <p className="text-sm text-muted-foreground">
              {member.email} · {member.employeeId}
            </p>
          </div>

          <input type="hidden" name="xeroConnectionId" value={xeroConnectionId} />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 text-sm font-semibold text-muted-foreground">
              <label htmlFor={`edit-role-${member.id}`}>Role</label>
              <Select name="role" defaultValue={state.values.role || "EMPLOYEE"} disabled={pending}>
                <SelectTrigger id={`edit-role-${member.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="EMPLOYEE">Basic Employee</SelectItem>
                  <SelectItem value="SUPERVISOR">Supervisor Employee</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <label className="space-y-2 text-sm font-semibold text-muted-foreground">
              Job title
              <Input name="jobTitle" defaultValue={state.values.jobTitle} disabled={pending} />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 text-sm font-semibold text-muted-foreground">
              Xero organization
              <div className="flex h-12 w-full items-center rounded-2xl border border-border/80 bg-card px-4 text-base text-foreground shadow-sm sm:h-11 sm:text-sm">
                {xeroDisplayName || "—"}
              </div>
            </div>

            {xeroConnectionId ? (
              <div className="space-y-2 text-sm font-semibold text-muted-foreground">
                <label htmlFor={`edit-project-${member.id}`}>Xero project</label>
                <input type="hidden" name="project" value={editProjectValue} />
                <Select
                  value={editProjectValue || "__none"}
                  onValueChange={(v) => setEditProjectValue(v === "__none" ? "" : v)}
                  disabled={pending || filteredProjects.length === 0}
                >
                  <SelectTrigger id={`edit-project-${member.id}`}>
                    <SelectValue
                      placeholder={filteredProjects.length > 0 ? "No project" : "Sync Xero projects first"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">No project</SelectItem>
                    {filteredProjects.map((project) => (
                      <SelectItem key={project.id} value={project.name}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>

          <div className="flex justify-end">
            <Button type="submit" className="rounded-xl" disabled={pending}>
              Save changes
            </Button>
          </div>
        </form>

        {/* ── Approval chain ──────────────────────────────────────────────── */}
        <div className="border-t border-border/60 pt-4 space-y-3">
          <div>
            <p className="text-sm font-semibold text-muted-foreground">Approval chain</p>
            <p className="mt-0.5 text-xs text-muted-foreground/70">
              Claims from {member.name} will require sign-off from each approver in order before reaching admin.
            </p>
          </div>

          {approverOptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No supervisors available. Add supervisors to your team first.
            </p>
          ) : (
            <div className="space-y-2">
              {chainApproverIds.map((approverId, index) => (
                <div key={index} className="flex items-center gap-2">
                  <span className="shrink-0 w-28 text-xs font-semibold text-muted-foreground">
                    {ordinalLabel(index + 1)}
                  </span>
                  <div className="flex-1">
                    <Select
                      value={approverId || undefined}
                      onValueChange={(v) => handleChainApproverChange(index, v)}
                      disabled={chainPending}
                    >
                      <SelectTrigger className="h-10">
                        <SelectValue placeholder="Select approver…" />
                      </SelectTrigger>
                      <SelectContent>
                        {approverOptions.map((s) => (
                          <SelectItem
                            key={s.id}
                            value={s.id}
                            disabled={chainApproverIds.some((id, i) => id === s.id && i !== index)}
                          >
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveChainStep(index)}
                    disabled={chainPending}
                    className="shrink-0 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}

              <div className="flex items-center justify-between pt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-xl"
                  onClick={handleAddChainStep}
                  disabled={chainPending || chainApproverIds.length >= approverOptions.length}
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Add supervisor
                </Button>

                <Button
                  type="button"
                  size="sm"
                  className="rounded-xl"
                  onClick={handleSaveChain}
                  disabled={chainPending || chainApproverIds.some((id) => !id)}
                >
                  {chainPending ? (
                    <><Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />Saving…</>
                  ) : (
                    "Save chain"
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
