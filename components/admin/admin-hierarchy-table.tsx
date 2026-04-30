"use client"

import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react"

import {
  createInitialAddHierarchyMemberFormState,
  createInitialHierarchyFormState,
} from "@/app/(admin)/admin/hierarchy/form-state"
import {
  createHierarchyMemberAction,
  saveApprovalChainAction,
  updateHierarchyAction,
} from "@/app/(admin)/admin/hierarchy/actions"
import { CheckSquare, ChevronDown, Loader2, Plus, Search, Square, X } from "lucide-react"

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
  EmployeePayoutMethod,
  OrganizationMember,
  OrganizationProjectOption,
  XeroConnectionInfo,
} from "@/modules/organization/domain/models"
import {
  employeePayoutMethodLabels,
  employeePayoutMethods,
  resolveEmployeePayoutMethod,
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
const payoutMethodOptions = employeePayoutMethods

function getDirectSupervisor(member: OrganizationMember) {
  return member.approvalChain[0]?.approverName ?? member.supervisorName ?? null
}

function formatAssignedProjects(member: OrganizationMember) {
  return member.projects.map((project) => project.name).join(", ")
}

function resolveSelectedProjectIds(
  memberProjects: OrganizationMember["projects"],
  availableProjects: OrganizationProjectOption[],
) {
  const availableById = new Set(availableProjects.map((project) => project.id))
  const availableByName = new Map(availableProjects.map((project) => [project.name, project.id]))

  return memberProjects
    .map((project) => {
      if (availableById.has(project.id)) {
        return project.id
      }

      return availableByName.get(project.name) ?? null
    })
    .filter((projectId): projectId is string => Boolean(projectId))
}

function ProjectMultiSelect({
  inputName,
  projects,
  selectedProjectIds,
  onToggle,
  disabled,
  helperText,
  legacyProjectName,
}: {
  inputName: string
  projects: OrganizationProjectOption[]
  selectedProjectIds: string[]
  onToggle: (projectId: string) => void
  disabled?: boolean
  helperText?: string
  legacyProjectName?: string
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const selectedProjects = projects.filter((project) => selectedProjectIds.includes(project.id))
  const triggerLabel =
    selectedProjects.length > 0
      ? selectedProjects.map((project) => project.name).join(", ")
      : "Select project(s)"

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    if (open) {
      document.addEventListener("mousedown", handlePointerDown)
    }

    return () => {
      document.removeEventListener("mousedown", handlePointerDown)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative space-y-2 text-sm font-semibold text-muted-foreground">
      {selectedProjectIds.map((projectId) => (
        <input key={projectId} type="hidden" name={inputName} value={projectId} />
      ))}
      {projects.length > 0 ? (
        <>
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            disabled={disabled}
            className="flex min-h-12 w-full items-center justify-between rounded-2xl border border-border/80 bg-card px-4 py-3 text-left text-sm text-foreground shadow-sm transition hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="pr-3">{triggerLabel}</span>
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 text-muted-foreground transition",
                open && "rotate-180",
              )}
            />
          </button>
          {open ? (
            <div className="absolute left-0 right-0 top-[calc(100%+0.5rem)] z-50 rounded-2xl border border-border/80 bg-card p-2 shadow-panel">
              <div className="max-h-64 space-y-1 overflow-y-auto">
              {projects.map((project) => {
                const isSelected = selectedProjectIds.includes(project.id)
                return (
                  <button
                    key={project.id}
                    type="button"
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-foreground transition hover:bg-surface-low disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={disabled}
                    onClick={() => onToggle(project.id)}
                  >
                    {isSelected ? (
                      <CheckSquare className="h-4 w-4 shrink-0 text-primary" />
                    ) : (
                      <Square className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span>{project.name}</span>
                  </button>
                )
              })}
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex h-12 w-full items-center rounded-2xl border border-border/80 bg-card px-4 text-sm text-muted-foreground shadow-sm">
          No projects available yet
        </div>
      )}
      {helperText ? <p className="text-xs font-medium text-muted-foreground">{helperText}</p> : null}
      {legacyProjectName ? (
        <p className="text-xs font-medium text-muted-foreground">
          Current legacy project: {legacyProjectName}
        </p>
      ) : null}
    </div>
  )
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
              formatAssignedProjects(member),
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
                <TableHead>Employee type</TableHead>
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
                  <TableCell colSpan={8} className="py-12 text-center text-sm text-muted-foreground">
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
                      <TableCell>{employeePayoutMethodLabels[member.payoutMethod]}</TableCell>
                      <TableCell>{member.xeroConnectionName ?? "—"}</TableCell>
                      <TableCell>{formatAssignedProjects(member) || "—"}</TableCell>
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
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([])
  const [addRoleValue, setAddRoleValue] = useState<"EMPLOYEE" | "SUPERVISOR">("EMPLOYEE")
  const [addPayoutMethodValue, setAddPayoutMethodValue] =
    useState<EmployeePayoutMethod>("HOURLY")
  const [state, formAction, pending] = useActionState(
    createHierarchyMemberAction,
    createInitialAddHierarchyMemberFormState()
  )

  const xeroConnectionId = xeroConnection?.id ?? ""
  const filteredProjects = xeroConnectionId
    ? projects.filter((p) => p.xeroConnectionId === xeroConnectionId)
    : projects
  const resolvedAddPayoutMethod = resolveEmployeePayoutMethod(
    addRoleValue,
    addPayoutMethodValue
  )

  useEffect(() => {
    if (state.status === "success") {
      toast({ title: state.message, variant: "success" })
      setOpen(false)
      setChainApproverIds([])
      setSelectedProjectIds([])
      setAddRoleValue("EMPLOYEE")
      setAddPayoutMethodValue("HOURLY")
    }

    if (state.status === "error" && state.message) {
      toast({ title: state.message, variant: "error" })
    }
  }, [state.status, state.message, toast])

  useEffect(() => {
    if (open) {
      setSelectedProjectIds([])
      setChainApproverIds([])
      setAddRoleValue("EMPLOYEE")
      setAddPayoutMethodValue("HOURLY")
    }
  }, [open])

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
              <Select
                name="role"
                value={addRoleValue}
                onValueChange={(value) => setAddRoleValue(value as "EMPLOYEE" | "SUPERVISOR")}
                disabled={pending}
              >
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

            <div className="space-y-2 text-sm font-semibold text-muted-foreground">
              <label htmlFor="add-payout-method">Employee type</label>
              <input type="hidden" name="payoutMethod" value={resolvedAddPayoutMethod} />
              <Select
                value={resolvedAddPayoutMethod}
                onValueChange={(value) => setAddPayoutMethodValue(value as EmployeePayoutMethod)}
                disabled={pending || addRoleValue === "SUPERVISOR"}
              >
                <SelectTrigger id="add-payout-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {payoutMethodOptions.map((method) => (
                    <SelectItem key={method} value={method}>
                      {employeePayoutMethodLabels[method]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {addRoleValue === "SUPERVISOR" ? (
                <p className="text-xs font-medium text-muted-foreground">
                  Supervisors are always daily-based paid.
                </p>
              ) : null}
            </div>

            <div className="space-y-2 text-sm font-semibold text-muted-foreground sm:col-span-2">
              Xero organization
              <input type="hidden" name="xeroConnectionId" value={xeroConnectionId} />
              <div className="flex h-12 w-full items-center rounded-2xl border border-border/80 bg-card px-4 text-base text-foreground shadow-sm sm:h-11 sm:text-sm">
                {xeroDisplayName || "—"}
              </div>
            </div>

            <div className="space-y-2 text-sm font-semibold text-muted-foreground sm:col-span-2">
              <label>Projects</label>
              <ProjectMultiSelect
                inputName="projectIds"
                projects={filteredProjects}
                selectedProjectIds={selectedProjectIds}
                disabled={pending}
                helperText="Select one or more projects for this employee."
                onToggle={(projectId) =>
                  setSelectedProjectIds((current) =>
                    current.includes(projectId)
                      ? current.filter((id) => id !== projectId)
                      : [...current, projectId]
                  )
                }
              />
            </div>

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
        payoutMethod: member.payoutMethod,
        supervisorId: member.supervisorId ?? "",
        xeroConnectionId,
      }),
    [member, xeroConnectionId]
  )
  const [state, formAction, pending] = useActionState(updateHierarchyAction, initialState)
  const [open, setOpen] = useState(false)
  const [editRoleValue, setEditRoleValue] = useState<"EMPLOYEE" | "SUPERVISOR">(member.role)
  const [editPayoutMethodValue, setEditPayoutMethodValue] = useState<EmployeePayoutMethod>(
    member.payoutMethod
  )
  const [selectedEditProjectIds, setSelectedEditProjectIds] = useState<string[]>(
    member.projects.filter((project) => !project.id.startsWith("legacy:")).map((project) => project.id)
  )

  // Approval chain state — initialised from the member's existing chain
  const [chainApproverIds, setChainApproverIds] = useState<string[]>(
    () => member.approvalChain.map((s) => s.approverId)
  )
  const [chainPending, startChainTransition] = useTransition()
  const resolvedEditPayoutMethod = resolveEmployeePayoutMethod(
    editRoleValue,
    editPayoutMethodValue
  )

  const filteredProjects = useMemo(() => {
    return xeroConnectionId
      ? projects.filter((p) => p.xeroConnectionId === xeroConnectionId)
      : projects
  }, [projects, xeroConnectionId])

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
      setEditRoleValue(member.role)
      setEditPayoutMethodValue(member.payoutMethod)
      setSelectedEditProjectIds(resolveSelectedProjectIds(member.projects, filteredProjects))
    }
  }, [
    open,
    member.approvalChain,
    member.payoutMethod,
    member.projects,
    member.role,
    filteredProjects,
  ])

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
              <Select
                name="role"
                value={editRoleValue}
                onValueChange={(value) => setEditRoleValue(value as "EMPLOYEE" | "SUPERVISOR")}
                disabled={pending}
              >
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

            <div className="space-y-2 text-sm font-semibold text-muted-foreground sm:col-span-2">
              <label htmlFor={`edit-payout-method-${member.id}`}>Employee type</label>
              <input type="hidden" name="payoutMethod" value={resolvedEditPayoutMethod} />
              <Select
                value={resolvedEditPayoutMethod}
                onValueChange={(value) => setEditPayoutMethodValue(value as EmployeePayoutMethod)}
                disabled={pending || editRoleValue === "SUPERVISOR"}
              >
                <SelectTrigger id={`edit-payout-method-${member.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {payoutMethodOptions.map((method) => (
                    <SelectItem key={method} value={method}>
                      {employeePayoutMethodLabels[method]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {editRoleValue === "SUPERVISOR" ? (
                <p className="text-xs font-medium text-muted-foreground">
                  Supervisors are always daily-based paid.
                </p>
              ) : null}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 text-sm font-semibold text-muted-foreground">
              Xero organization
              <div className="flex h-12 w-full items-center rounded-2xl border border-border/80 bg-card px-4 text-base text-foreground shadow-sm sm:h-11 sm:text-sm">
                {xeroDisplayName || "—"}
              </div>
            </div>

            <div className="space-y-2 text-sm font-semibold text-muted-foreground">
              <label>Projects</label>
              <ProjectMultiSelect
                inputName="projectIds"
                projects={filteredProjects}
                selectedProjectIds={selectedEditProjectIds}
                disabled={pending}
                legacyProjectName={
                  member.projects.find((project) => project.id.startsWith("legacy:"))?.name
                }
                onToggle={(projectId) =>
                  setSelectedEditProjectIds((current) =>
                    current.includes(projectId)
                      ? current.filter((id) => id !== projectId)
                      : [...current, projectId]
                  )
                }
              />
            </div>
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
