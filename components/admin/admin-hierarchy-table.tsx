"use client"

import { useActionState, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import {
  createInitialAddHierarchyMemberFormState,
  createInitialHierarchyFormState,
} from "@/app/(admin)/admin/hierarchy/form-state"
import {
  createHierarchyMemberAction,
  updateHierarchyAction,
} from "@/app/(admin)/admin/hierarchy/actions"
import { CheckSquare, ChevronDown, Loader2, Plus, Search, Square } from "lucide-react"

import { ImportPayrollEmployeesButton } from "@/components/admin/import-payroll-employees-button"
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
  TeamSummary,
  XeroConnectionInfo,
} from "@/modules/organization/domain/models"
import {
  employeePayoutMethodLabels,
  otPayoutMethodLabels,
} from "@/modules/organization/domain/models"
import type { EmployeePolicy } from "@/modules/policy/domain/models"

type AdminHierarchyTableProps = {
  members: OrganizationMember[]
  projects: OrganizationProjectOption[]
  xeroConnections: XeroConnectionInfo[]
  organizationName: string
  teams: TeamSummary[]
  /// Org's employee policies. Active (non-archived) entries populate the
  /// required "Policy" dropdown in the Add/Edit member dialogs.
  policies?: EmployeePolicy[]
}

type RoleFilter = "ALL" | "EMPLOYEE" | "SUPERVISOR"
type ProjectFilter = "ALL" | "UNASSIGNED" | string

const PAGE_SIZE = 10

const roleLabels: Record<Exclude<RoleFilter, "ALL">, string> = {
  EMPLOYEE: "Basic Employee",
  SUPERVISOR: "Supervisor Employee",
}

const roleOptions: Exclude<RoleFilter, "ALL">[] = ["EMPLOYEE", "SUPERVISOR"]

function getDirectSupervisor(member: OrganizationMember) {
  // Use the first team's first chain step's first approver as the
  // visible supervisor.
  const firstChainStep = member.teams.flatMap((t) => t.chain)[0]
  const firstApprover = firstChainStep?.approvers[0]
  return firstApprover?.approverName ?? null
}

function chainStepCount(member: OrganizationMember) {
  // Total number of distinct steps across all teams. Used to show
  // "N-step chain" hint in the table.
  return member.teams.reduce((acc, t) => acc + t.chain.length, 0)
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
}: {
  inputName: string
  projects: OrganizationProjectOption[]
  selectedProjectIds: string[]
  onToggle: (projectId: string) => void
  disabled?: boolean
  helperText?: string
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
    </div>
  )
}

/**
 * Per-layer multi-select supervisor picker. Renders a checkbox list of
 * candidates for a single layer; selection is multi (any-of approval).
 *
 * Form data: emits one hidden input per selected userId with `name` set
 * to `namePrefix` (e.g. `proj.<pid>.chainApprover.2`). The action reads
 * via formData.getAll/entries — multiple values under the same name are
 * preserved.
 */
function ChainLayerMultiPicker({
  layer,
  label,
  candidates,
  selectedIds,
  disabled,
  namePrefix,
  onToggle,
}: {
  layer: number
  label: string
  candidates: OrganizationMember[]
  selectedIds: string[]
  disabled: boolean
  namePrefix: string
  onToggle: (userId: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-semibold text-muted-foreground">
        L{layer} approver
        <span className="ml-1 font-normal text-muted-foreground/70">
          — {label}
        </span>
      </label>
      {candidates.length === 0 ? (
        <div className="flex h-12 w-full items-center rounded-2xl border border-border/80 bg-card px-4 text-sm text-muted-foreground shadow-sm">
          No L{layer} supervisors in this team
        </div>
      ) : (
        <div className="rounded-2xl border border-border/80 bg-card p-2 max-h-[200px] overflow-y-auto shadow-sm">
          {candidates.map((s) => {
            const checked = selectedIds.includes(s.id)
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onToggle(s.id)}
                disabled={disabled}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-50",
                  checked
                    ? "bg-primary/8 text-foreground"
                    : "text-muted-foreground hover:bg-surface-low/80",
                )}
              >
                <span className="truncate">{s.name}</span>
                {checked ? (
                  <span className="text-[10px] font-semibold uppercase text-primary">
                    Selected
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      )}
      {selectedIds.length > 0 ? (
        <p className="text-[11px] font-normal text-muted-foreground">
          {selectedIds.length === 1
            ? "1 approver — they must approve."
            : `${selectedIds.length} approvers — any one of them approves.`}
        </p>
      ) : null}
      {/* One hidden input per selected user. The action receives them all
          via formData.entries() under the same name. */}
      {selectedIds.map((userId) => (
        <input key={userId} type="hidden" name={namePrefix} value={userId} />
      ))}
    </div>
  )
}

export function AdminHierarchyTable({
  members,
  projects,
  xeroConnections,
  organizationName,
  teams,
  policies = [],
}: AdminHierarchyTableProps) {
  const supervisors = members.filter((member) => member.role === "SUPERVISOR")
  const [page, setPage] = useState(1)
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("ALL")
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>("ALL")
  const [searchTerm, setSearchTerm] = useState("")

  // One company connects to at most one Xero tenant. Use the first connection if any.
  const xeroConnection = xeroConnections[0]
  const xeroDisplayName = xeroConnection?.tenantName ?? organizationName

  const filteredMembers = useMemo(() => {
    const normalizedQuery = searchTerm.trim().toLowerCase()

    return members.filter((member) => {
      const matchesRole = roleFilter === "ALL" ? true : member.role === roleFilter

      const matchesProject =
        projectFilter === "ALL"
          ? true
          : projectFilter === "UNASSIGNED"
          ? member.projects.length === 0
          : member.projects.some((p) => p.id === projectFilter)

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

      return matchesRole && matchesProject && matchesQuery
    })
  }, [members, roleFilter, projectFilter, searchTerm])

  useEffect(() => {
    setPage(1)
  }, [roleFilter, projectFilter, searchTerm])

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

  const hasActiveFilters = roleFilter !== "ALL" || projectFilter !== "ALL" || searchTerm.trim().length > 0

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

            <div className="flex flex-wrap items-center gap-2">
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
              {projects.length > 0 && (
                <Select
                  value={projectFilter}
                  onValueChange={(v) => setProjectFilter(v as ProjectFilter)}
                >
                  <SelectTrigger className="h-8 rounded-full border-border/70 bg-surface-low text-sm font-semibold text-muted-foreground shadow-none w-auto min-w-[140px]">
                    <SelectValue placeholder="All projects" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All projects</SelectItem>
                    <SelectItem value="UNASSIGNED">Unassigned</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
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
            {projects.length > 0 && (
              <div className="mt-2">
                <Select
                  value={projectFilter}
                  onValueChange={(v) => setProjectFilter(v as ProjectFilter)}
                >
                  <SelectTrigger className="h-10 rounded-2xl border-border/70 text-sm font-semibold text-muted-foreground w-full">
                    <SelectValue placeholder="All projects" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All projects</SelectItem>
                    <SelectItem value="UNASSIGNED">Unassigned</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
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
                  setProjectFilter("ALL")
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
          <div className="flex flex-wrap items-center gap-2">
            <ImportPayrollEmployeesButton />
            <AddHierarchyMemberDialog
              supervisors={supervisors}
              projects={projects}
              xeroConnection={xeroConnection}
              xeroDisplayName={xeroDisplayName}
              teams={teams}
              allMembers={members}
              policies={policies}
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-4 p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Policy</TableHead>
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
                      <TableCell>{member.policyName ?? employeePayoutMethodLabels[member.payoutMethod]}</TableCell>
                      <TableCell>{member.xeroConnectionName ?? "—"}</TableCell>
                      <TableCell>{formatAssignedProjects(member) || "—"}</TableCell>
                      <TableCell>{member.jobTitle}</TableCell>
                      <TableCell>
                        <div>
                          <p>{directSupervisor ?? "No supervisor"}</p>
                          {chainStepCount(member) > 1 ? (
                            <p className="text-xs text-muted-foreground">
                              {chainStepCount(member)}-step chain
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
                          teams={teams}
                          allMembers={members}
                          policies={policies}
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
  teams,
  allMembers,
  policies,
}: {
  supervisors: OrganizationMember[]
  projects: OrganizationProjectOption[]
  xeroConnection: XeroConnectionInfo | undefined
  xeroDisplayName: string
  teams: TeamSummary[]
  allMembers: OrganizationMember[]
  policies: EmployeePolicy[]
}) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([])
  /// Per-project routing config keyed by projectId. Each entry has the
  /// chosen team, the employee's layer in that team, and per-layer chain
  /// pickers. chainApproverByLayer[layer] is a list of supervisor user ids
  /// (any-of approval) — multiple supervisors can sit at the same layer.
  const [projectConfigs, setProjectConfigs] = useState<
    Record<string, { teamId: string; layer: number; chainApproverByLayer: Record<number, string[]> }>
  >({})
  const [addRoleValue, setAddRoleValue] = useState<"EMPLOYEE" | "SUPERVISOR">("EMPLOYEE")
  const activePolicies = useMemo(
    () => policies.filter((p) => !p.archived),
    [policies],
  )
  const defaultPolicyId = useMemo(
    () =>
      activePolicies.find((p) => p.isDefault)?.id ?? activePolicies[0]?.id ?? "",
    [activePolicies],
  )
  const [addPolicyId, setAddPolicyId] = useState<string>(defaultPolicyId)
  useEffect(() => {
    if (!addPolicyId && defaultPolicyId) {
      setAddPolicyId(defaultPolicyId)
    }
  }, [defaultPolicyId, addPolicyId])
  const selectedAddPolicy = activePolicies.find((p) => p.id === addPolicyId)
  const [state, formAction, pending] = useActionState(
    createHierarchyMemberAction,
    createInitialAddHierarchyMemberFormState()
  )
  const router = useRouter()

  const xeroConnectionId = xeroConnection?.id ?? ""
  const filteredProjects = xeroConnectionId
    ? projects.filter((p) => p.xeroConnectionId === xeroConnectionId)
    : projects
  const projectsById = useMemo(
    () => new Map(filteredProjects.map((p) => [p.id, p])),
    [filteredProjects],
  )
  const teamsByProject = useMemo(() => {
    const map = new Map<string, TeamSummary[]>()
    for (const t of teams) {
      const list = map.get(t.projectId) ?? []
      list.push(t)
      map.set(t.projectId, list)
    }
    return map
  }, [teams])

  const supervisorsAtLayerInTeam = (
    teamId: string,
    layer: number,
  ): OrganizationMember[] => {
    return allMembers.filter(
      (m) =>
        m.role === "SUPERVISOR" &&
        m.teams.some((t) => t.teamId === teamId && t.layer === layer),
    )
  }

  // For each selected project, compute layers above and check chain
  // completeness. A layer is complete when at least one supervisor has
  // been picked for it.
  const allChainsComplete = selectedProjectIds.every((pid) => {
    const cfg = projectConfigs[pid]
    if (!cfg || !cfg.teamId) return false
    const team = teams.find((t) => t.id === cfg.teamId)
    if (!team) return false
    for (let l = cfg.layer + 1; l <= team.layerCount; l++) {
      if ((cfg.chainApproverByLayer[l] ?? []).length === 0) return false
    }
    return true
  })

  useEffect(() => {
    if (state.status === "success") {
      toast({ title: state.message, variant: "success" })
      setOpen(false)
      setSelectedProjectIds([])
      setProjectConfigs({})
      setAddRoleValue("EMPLOYEE")
      // The server action calls revalidatePath() but the client RSC
      // payload still has the old member list cached. router.refresh()
      // forces Next.js to re-fetch the current route so the new
      // employee row shows up immediately, instead of staying invisible
      // until the user navigates away and back.
      router.refresh()
    }

    if (state.status === "error" && state.message) {
      toast({ title: state.message, variant: "error" })
    }
  }, [state.status, state.message, toast, router])

  useEffect(() => {
    if (open) {
      setSelectedProjectIds([])
      setProjectConfigs({})
      setAddRoleValue("EMPLOYEE")
    }
  }, [open])

  // When projects are toggled, prune configs for unselected projects.
  useEffect(() => {
    setProjectConfigs((prev) => {
      const out: typeof prev = {}
      for (const pid of selectedProjectIds) {
        out[pid] = prev[pid] ?? {
          teamId: "",
          layer: 1,
          chainApproverByLayer: {},
        }
      }
      return out
    })
  }, [selectedProjectIds.join(",")])

  // EMPLOYEE role defaults to layer 1 in every project config.
  useEffect(() => {
    if (addRoleValue === "EMPLOYEE") {
      setProjectConfigs((prev) => {
        const out: typeof prev = {}
        for (const pid of Object.keys(prev)) {
          out[pid] = { ...prev[pid]!, layer: 1 }
        }
        return out
      })
    }
  }, [addRoleValue])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" className="rounded-full">
          Add employee
        </Button>
      </DialogTrigger>
      <DialogContent
        className="flex max-h-[90vh] w-[min(92vw,760px)] flex-col overflow-hidden px-6 pb-6 pt-6 sm:max-w-[760px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>Add employee</DialogTitle>
          <DialogDescription>
            Create a new employee or supervisor account inside your organization and assign their reporting details.
          </DialogDescription>
        </DialogHeader>
        <div
          className="flex-1 overflow-y-auto pr-3"
          style={{ scrollbarGutter: "stable both-edges" }}
        >
          <form action={formAction} className="space-y-5 pb-2">
            <div className="space-y-5 rounded-[28px] border border-border/70 bg-card/90 p-5 shadow-sm">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-2 text-sm font-semibold text-muted-foreground">
                  <span>Full name</span>
                  <Input name="name" defaultValue={state.values.name} disabled={pending} />
                </label>

                <label className="space-y-2 text-sm font-semibold text-muted-foreground">
                  <span>Employee ID</span>
                  <Input name="employeeId" defaultValue={state.values.employeeId} disabled={pending} />
                </label>

                <label className="space-y-2 text-sm font-semibold text-muted-foreground sm:col-span-2">
                  <span>Email</span>
                  <Input
                    name="email"
                    type="email"
                    defaultValue={state.values.email}
                    disabled={pending}
                  />
                </label>

                <label className="space-y-2 text-sm font-semibold text-muted-foreground sm:col-span-2">
                  <span>Temporary password</span>
                  <Input
                    name="password"
                    type="password"
                    defaultValue={state.values.password}
                    disabled={pending}
                  />
                </label>
              </div>
            </div>

            <div className="space-y-5 rounded-[28px] border border-border/70 bg-card/90 p-5 shadow-sm">
              <div className="grid gap-4 sm:grid-cols-2">
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
                  <span>Job title</span>
                  <Input name="jobTitle" defaultValue={state.values.jobTitle} disabled={pending} />
                </label>
              </div>

              <div className="space-y-2 text-sm font-semibold text-muted-foreground">
                <label htmlFor="add-policy-id">Employee policy</label>
                <input type="hidden" name="policyId" value={addPolicyId} />
                {activePolicies.length > 0 ? (
                  <Select
                    value={addPolicyId}
                    onValueChange={(value) => setAddPolicyId(value)}
                    disabled={pending}
                  >
                    <SelectTrigger id="add-policy-id">
                      <SelectValue placeholder="Pick a policy" />
                    </SelectTrigger>
                    <SelectContent>
                      {activePolicies.map((policy) => (
                        <SelectItem key={policy.id} value={policy.id}>
                          {policy.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="flex flex-col gap-3 rounded-2xl border border-dashed border-border/80 bg-surface-low px-4 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                    <span className="font-medium">
                      Create an employee policy before adding employees.
                    </span>
                    <Button asChild type="button" size="sm" variant="outline" className="shrink-0">
                      <Link href="/admin/settings?tab=policies">
                        <Plus className="h-4 w-4" />
                        Create policy
                      </Link>
                    </Button>
                  </div>
                )}
                {selectedAddPolicy ? (
                  <p className="text-xs font-normal text-muted-foreground">
                    {employeePayoutMethodLabels[selectedAddPolicy.salaryType]} ·{" "}
                    {selectedAddPolicy.otEnabled
                      ? `OT paid as ${otPayoutMethodLabels[selectedAddPolicy.otMethod].toLowerCase()}`
                      : "OT disabled"}
                    {addRoleValue === "SUPERVISOR"
                      ? " · supervisors are always paid monthly"
                      : ""}
                  </p>
                ) : null}
              </div>

              <div className="space-y-2 text-sm font-semibold text-muted-foreground">
                <span>Xero organization</span>
                <input type="hidden" name="xeroConnectionId" value={xeroConnectionId} />
                <div className="flex min-h-12 w-full items-center rounded-2xl border border-border/80 bg-card px-4 py-3 text-sm text-foreground shadow-sm">
                  {xeroDisplayName || "—"}
                </div>
              </div>

              <div className="space-y-2 text-sm font-semibold text-muted-foreground">
                <label>Projects</label>
                <ProjectMultiSelect
                  inputName="projectIds"
                  projects={filteredProjects}
                  selectedProjectIds={selectedProjectIds}
                  disabled={pending}
                  helperText="Select the projects this employee will work on. Each project gets its own team + chain below."
                  onToggle={(projectId) =>
                    setSelectedProjectIds((current) =>
                      current.includes(projectId)
                        ? current.filter((id) => id !== projectId)
                        : [...current, projectId],
                    )
                  }
                />
              </div>
            </div>

            {/* Per-project team + chain configuration. */}
            {selectedProjectIds.length === 0 ? (
              <div className="rounded-[28px] border border-dashed border-border/70 bg-card/40 p-5 text-sm text-muted-foreground">
                Select one or more projects above to configure team + chain.
              </div>
            ) : (
              selectedProjectIds.map((pid) => {
                const project = projectsById.get(pid)
                if (!project) return null
                const cfg = projectConfigs[pid] ?? {
                  teamId: "",
                  layer: 1,
                  chainApproverByLayer: {},
                }
                const projectTeams = teamsByProject.get(pid) ?? []
                const team = projectTeams.find((t) => t.id === cfg.teamId)
                const layersAbove = team
                  ? Array.from(
                      { length: Math.max(0, team.layerCount - cfg.layer) },
                      (_, i) => cfg.layer + i + 1,
                    )
                  : []
                return (
                  <div
                    key={pid}
                    className="space-y-4 rounded-[28px] border border-border/70 bg-card/90 p-5 shadow-sm"
                  >
                    <div>
                      <p className="text-sm font-semibold text-foreground">
                        {project.name}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground/70">
                        Team and approval chain for this project.
                      </p>
                    </div>

                    <input type="hidden" name={`proj.${pid}.teamId`} value={cfg.teamId} />
                    <input type="hidden" name={`proj.${pid}.layer`} value={String(cfg.layer)} />

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2 text-sm font-semibold text-muted-foreground">
                        <label htmlFor={`add-team-${pid}`}>Team</label>
                        <Select
                          value={cfg.teamId || undefined}
                          onValueChange={(v) =>
                            setProjectConfigs((prev) => ({
                              ...prev,
                              [pid]: {
                                teamId: v,
                                layer: 1,
                                chainApproverByLayer: {},
                              },
                            }))
                          }
                          disabled={pending}
                        >
                          <SelectTrigger id={`add-team-${pid}`}>
                            <SelectValue
                              placeholder={
                                projectTeams.length === 0
                                  ? "No teams in this project"
                                  : "Select team"
                              }
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {projectTeams.map((t) => (
                              <SelectItem key={t.id} value={t.id}>
                                {t.name} · {t.layerCount} layer{t.layerCount === 1 ? "" : "s"}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {addRoleValue === "SUPERVISOR" && team ? (
                        <div className="space-y-2 text-sm font-semibold text-muted-foreground">
                          <label htmlFor={`add-layer-${pid}`}>
                            This employee&apos;s layer
                          </label>
                          <Select
                            value={String(cfg.layer)}
                            onValueChange={(v) =>
                              setProjectConfigs((prev) => ({
                                ...prev,
                                [pid]: {
                                  ...prev[pid]!,
                                  layer: Number(v) || 1,
                                  chainApproverByLayer: {},
                                },
                              }))
                            }
                            disabled={pending}
                          >
                            <SelectTrigger id={`add-layer-${pid}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {Array.from(
                                { length: team.layerCount },
                                (_, i) => i + 1,
                              ).map((layer) => {
                                // Empty-string labels fall back to "Layer N"
                                // (?? would keep "" as-is and look broken).
                                const label =
                                  team.layerLabels?.[layer - 1]?.trim() ||
                                  `Layer ${layer}`
                                return (
                                  <SelectItem key={layer} value={String(layer)}>
                                    L{layer} — {label}
                                  </SelectItem>
                                )
                              })}
                            </SelectContent>
                          </Select>
                        </div>
                      ) : null}
                    </div>

                    {!team ? (
                      <p className="text-sm text-muted-foreground">
                        Pick a team to configure the approval chain.
                      </p>
                    ) : layersAbove.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        This employee is at the top layer — nobody approves above them in this project.
                      </p>
                    ) : (
                      <div className="space-y-3">
                        <p className="text-xs font-medium text-muted-foreground/80">
                          Approval chain (pick any number per layer — any one approves to advance)
                        </p>
                        {layersAbove.map((layer) => {
                          const candidates = supervisorsAtLayerInTeam(team.id, layer)
                          const selected = cfg.chainApproverByLayer[layer] ?? []
                          const label =
                            team.layerLabels?.[layer - 1]?.trim() ||
                            `Layer ${layer}`
                          return (
                            <ChainLayerMultiPicker
                              key={layer}
                              layer={layer}
                              label={label}
                              candidates={candidates}
                              selectedIds={selected}
                              disabled={pending}
                              namePrefix={`proj.${pid}.chainApprover.${layer}`}
                              onToggle={(uid) =>
                                setProjectConfigs((prev) => {
                                  const cur = prev[pid]!.chainApproverByLayer[layer] ?? []
                                  const next = cur.includes(uid)
                                    ? cur.filter((id) => id !== uid)
                                    : [...cur, uid]
                                  return {
                                    ...prev,
                                    [pid]: {
                                      ...prev[pid]!,
                                      chainApproverByLayer: {
                                        ...prev[pid]!.chainApproverByLayer,
                                        [layer]: next,
                                      },
                                    },
                                  }
                                })
                              }
                            />
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })
            )}

            <div className="flex justify-end border-t border-border/60 pt-4">
              <Button
                type="submit"
                className="rounded-xl"
                disabled={
                  pending ||
                  activePolicies.length === 0 ||
                  !addPolicyId ||
                  selectedProjectIds.length === 0 ||
                  !allChainsComplete
                }
              >
                {pending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Creating…</> : "Create employee"}
              </Button>
            </div>
          </form>
        </div>
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
  teams,
  allMembers,
  policies,
}: {
  member: OrganizationMember
  supervisors: OrganizationMember[]
  projects: OrganizationProjectOption[]
  xeroConnection: XeroConnectionInfo | undefined
  xeroDisplayName: string
  teams: TeamSummary[]
  allMembers: OrganizationMember[]
  policies: EmployeePolicy[]
}) {
  const { toast } = useToast()
  const xeroConnectionId = xeroConnection?.id ?? ""
  const initialState = useMemo(
    () =>
      createInitialHierarchyFormState({
        role: member.role,
        organizationId: member.organizationId ?? "",
        jobTitle: member.jobTitle,
        xeroConnectionId,
      }),
    [member, xeroConnectionId]
  )
  const [state, formAction, pending] = useActionState(updateHierarchyAction, initialState)
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [editRoleValue, setEditRoleValue] = useState<"EMPLOYEE" | "SUPERVISOR">(member.role)
  const activePolicies = useMemo(
    () => policies.filter((p) => !p.archived),
    [policies],
  )
  const fallbackPolicyId = useMemo(
    () => activePolicies.find((p) => p.isDefault)?.id ?? activePolicies[0]?.id ?? "",
    [activePolicies],
  )
  const [editPolicyId, setEditPolicyId] = useState<string>(
    member.policyId ?? fallbackPolicyId,
  )
  const selectedEditPolicy = activePolicies.find((p) => p.id === editPolicyId)
  const [selectedEditProjectIds, setSelectedEditProjectIds] = useState<string[]>(
    member.projects.map((project) => project.id)
  )

  /// Per-project routing config keyed by projectId. Prefilled from the
  /// member's existing team memberships and grouped chain steps.
  /// chainApproverByLayer[layer] is a list of supervisor user ids
  /// (any-of approval) — multiple supervisors can sit at the same layer.
  const [projectConfigs, setProjectConfigs] = useState<
    Record<
      string,
      { teamId: string; layer: number; chainApproverByLayer: Record<number, string[]> }
    >
  >(() => {
    const out: Record<
      string,
      { teamId: string; layer: number; chainApproverByLayer: Record<number, string[]> }
    > = {}
    for (const t of member.teams) {
      const map: Record<number, string[]> = {}
      t.chain.forEach((step, idx) => {
        map[t.layer + idx + 1] = step.approvers.map((a) => a.approverId)
      })
      out[t.projectId] = {
        teamId: t.teamId,
        layer: t.layer,
        chainApproverByLayer: map,
      }
    }
    return out
  })
  const filteredProjects = useMemo(() => {
    return xeroConnectionId
      ? projects.filter((p) => p.xeroConnectionId === xeroConnectionId)
      : projects
  }, [projects, xeroConnectionId])

  const projectsById = useMemo(
    () => new Map(filteredProjects.map((p) => [p.id, p])),
    [filteredProjects],
  )
  const teamsByProject = useMemo(() => {
    const map = new Map<string, TeamSummary[]>()
    for (const t of teams) {
      const list = map.get(t.projectId) ?? []
      list.push(t)
      map.set(t.projectId, list)
    }
    return map
  }, [teams])

  const supervisorsAtLayerInTeam = (
    teamId: string,
    layer: number,
  ): OrganizationMember[] => {
    return allMembers.filter(
      (m) =>
        m.id !== member.id &&
        m.role === "SUPERVISOR" &&
        m.teams.some((t) => t.teamId === teamId && t.layer === layer),
    )
  }

  const allChainsComplete = selectedEditProjectIds.every((pid) => {
    const cfg = projectConfigs[pid]
    if (!cfg || !cfg.teamId) return false
    const team = teams.find((t) => t.id === cfg.teamId)
    if (!team) return false
    for (let l = cfg.layer + 1; l <= team.layerCount; l++) {
      if ((cfg.chainApproverByLayer[l] ?? []).length === 0) return false
    }
    return true
  })

  useEffect(() => {
    if (state.status === "success") {
      toast({ title: state.message, variant: "success" })
      setOpen(false)
      // See AddHierarchyMemberDialog — server-side revalidatePath() alone
      // doesn't bust the client RSC cache, so the edited row would keep
      // showing pre-edit values until navigation. Refresh explicitly.
      router.refresh()
    }

    if (state.status === "error" && state.message) {
      toast({ title: state.message, variant: "error" })
    }
  }, [state.status, state.message, toast, router])

  // Reset on open/member change
  useEffect(() => {
    if (open) {
      setEditRoleValue(member.role)
      setEditPolicyId(member.policyId ?? fallbackPolicyId)
      setSelectedEditProjectIds(resolveSelectedProjectIds(member.projects, filteredProjects))
      const out: Record<
        string,
        { teamId: string; layer: number; chainApproverByLayer: Record<number, string[]> }
      > = {}
      for (const t of member.teams) {
        const map: Record<number, string[]> = {}
        t.chain.forEach((step, idx) => {
          map[t.layer + idx + 1] = step.approvers.map((a) => a.approverId)
        })
        out[t.projectId] = {
          teamId: t.teamId,
          layer: t.layer,
          chainApproverByLayer: map,
        }
      }
      setProjectConfigs(out)
    }
  }, [
    open,
    member.projects,
    member.role,
    member.teams,
    filteredProjects,
  ])

  // When projects are toggled, prune configs for unselected projects and
  // make sure newly-selected projects have a placeholder entry.
  useEffect(() => {
    setProjectConfigs((prev) => {
      const out: typeof prev = {}
      for (const pid of selectedEditProjectIds) {
        out[pid] = prev[pid] ?? {
          teamId: "",
          layer: 1,
          chainApproverByLayer: {},
        }
      }
      return out
    })
  }, [selectedEditProjectIds.join(",")])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="rounded-full">
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent
        className="flex max-h-[90vh] w-[min(92vw,760px)] flex-col overflow-hidden px-6 pb-6 pt-6 sm:max-w-[760px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>Edit hierarchy</DialogTitle>
          <DialogDescription>
            Update {member.name}&apos;s role, project, title, and approval chain.
          </DialogDescription>
        </DialogHeader>
        <div
          className="flex-1 overflow-y-auto pr-3"
          style={{ scrollbarGutter: "stable both-edges" }}
        >

        {/* ── Role / project / title form ─────────────────────────────────── */}
        <div className="space-y-5 pb-2">
          <form
            action={formAction}
            className="space-y-5 rounded-[28px] border border-border/70 bg-card/90 p-5 shadow-sm"
          >
            <input type="hidden" name="userId" value={member.id} />
            <input type="hidden" name="email" value={member.email} />
            <input type="hidden" name="xeroConnectionId" value={xeroConnectionId} />

            <div className="rounded-3xl bg-surface-low p-4">
              <p className="font-bold text-foreground">{member.name}</p>
              <p className="text-sm text-muted-foreground">
                {member.email} · {member.employeeId}
              </p>
            </div>

            <div className="space-y-4">
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
                  <span>Job title</span>
                  <Input name="jobTitle" defaultValue={state.values.jobTitle} disabled={pending} />
                </label>
              </div>

              <div className="space-y-2 text-sm font-semibold text-muted-foreground">
                <label htmlFor={`edit-policy-${member.id}`}>Employee policy</label>
                <input type="hidden" name="policyId" value={editPolicyId} />
                {activePolicies.length > 0 ? (
                  <Select
                    value={editPolicyId}
                    onValueChange={(v) => setEditPolicyId(v)}
                    disabled={pending}
                  >
                    <SelectTrigger id={`edit-policy-${member.id}`}>
                      <SelectValue placeholder="Pick a policy" />
                    </SelectTrigger>
                    <SelectContent>
                      {activePolicies.map((policy) => (
                        <SelectItem key={policy.id} value={policy.id}>
                          {policy.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="flex flex-col gap-3 rounded-2xl border border-dashed border-border/80 bg-surface-low px-4 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                    <span className="font-medium">
                      Create an employee policy before editing employees.
                    </span>
                    <Button asChild type="button" size="sm" variant="outline" className="shrink-0">
                      <Link href="/admin/settings?tab=policies">
                        <Plus className="h-4 w-4" />
                        Create policy
                      </Link>
                    </Button>
                  </div>
                )}
                {selectedEditPolicy ? (
                  <p className="text-xs font-normal text-muted-foreground">
                    {employeePayoutMethodLabels[selectedEditPolicy.salaryType]} ·{" "}
                    {selectedEditPolicy.otEnabled
                      ? `OT paid as ${otPayoutMethodLabels[selectedEditPolicy.otMethod].toLowerCase()}`
                      : "OT disabled"}
                    {editRoleValue === "SUPERVISOR"
                      ? " · supervisors are always paid monthly"
                      : ""}
                  </p>
                ) : null}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 text-sm font-semibold text-muted-foreground">
                  <span>Xero organization</span>
                  <div className="flex min-h-12 w-full items-center rounded-2xl border border-border/80 bg-card px-4 py-3 text-sm text-foreground shadow-sm">
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
                    onToggle={(projectId) =>
                      setSelectedEditProjectIds((current) =>
                        current.includes(projectId)
                          ? current.filter((id) => id !== projectId)
                          : [...current, projectId],
                      )
                    }
                  />
                </div>
              </div>
            </div>

            {/* Per-project team + chain configuration. */}
            {selectedEditProjectIds.length === 0 ? (
              <div className="rounded-[28px] border border-dashed border-border/70 bg-card/40 p-5 text-sm text-muted-foreground">
                Pick at least one project above.
              </div>
            ) : (
              selectedEditProjectIds.map((pid) => {
                const project = projectsById.get(pid)
                if (!project) return null
                const cfg = projectConfigs[pid] ?? {
                  teamId: "",
                  layer: 1,
                  chainApproverByLayer: {},
                }
                const projectTeams = teamsByProject.get(pid) ?? []
                const team = projectTeams.find((t) => t.id === cfg.teamId)
                const layersAbove = team
                  ? Array.from(
                      { length: Math.max(0, team.layerCount - cfg.layer) },
                      (_, i) => cfg.layer + i + 1,
                    )
                  : []
                return (
                  <div
                    key={pid}
                    className="space-y-4 rounded-[28px] border border-border/70 bg-card/90 p-5 shadow-sm"
                  >
                    <div>
                      <p className="text-sm font-semibold text-foreground">
                        {project.name}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground/70">
                        Team and approval chain for this project.
                      </p>
                    </div>

                    <input type="hidden" name={`proj.${pid}.teamId`} value={cfg.teamId} />
                    <input type="hidden" name={`proj.${pid}.layer`} value={String(cfg.layer)} />

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2 text-sm font-semibold text-muted-foreground">
                        <label htmlFor={`edit-team-${member.id}-${pid}`}>Team</label>
                        <Select
                          value={cfg.teamId || undefined}
                          onValueChange={(v) =>
                            setProjectConfigs((prev) => ({
                              ...prev,
                              [pid]: {
                                teamId: v,
                                layer: 1,
                                chainApproverByLayer: {},
                              },
                            }))
                          }
                          disabled={pending}
                        >
                          <SelectTrigger id={`edit-team-${member.id}-${pid}`}>
                            <SelectValue
                              placeholder={
                                projectTeams.length === 0
                                  ? "No teams in this project"
                                  : "Select team"
                              }
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {projectTeams.map((t) => (
                              <SelectItem key={t.id} value={t.id}>
                                {t.name} · {t.layerCount} layer{t.layerCount === 1 ? "" : "s"}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {editRoleValue === "SUPERVISOR" && team ? (
                        <div className="space-y-2 text-sm font-semibold text-muted-foreground">
                          <label htmlFor={`edit-layer-${member.id}-${pid}`}>
                            This employee&apos;s layer
                          </label>
                          <Select
                            value={String(cfg.layer)}
                            onValueChange={(v) =>
                              setProjectConfigs((prev) => ({
                                ...prev,
                                [pid]: {
                                  ...prev[pid]!,
                                  layer: Number(v) || 1,
                                  chainApproverByLayer: {},
                                },
                              }))
                            }
                            disabled={pending}
                          >
                            <SelectTrigger id={`edit-layer-${member.id}-${pid}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {Array.from(
                                { length: team.layerCount },
                                (_, i) => i + 1,
                              ).map((layer) => {
                                // Empty-string labels fall back to "Layer N"
                                // (?? would keep "" as-is and look broken).
                                const label =
                                  team.layerLabels?.[layer - 1]?.trim() ||
                                  `Layer ${layer}`
                                return (
                                  <SelectItem key={layer} value={String(layer)}>
                                    L{layer} — {label}
                                  </SelectItem>
                                )
                              })}
                            </SelectContent>
                          </Select>
                        </div>
                      ) : null}
                    </div>

                    {!team ? (
                      <p className="text-sm text-muted-foreground">
                        Pick a team to configure the approval chain.
                      </p>
                    ) : layersAbove.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        This employee is at the top layer — nobody approves above them in this project.
                      </p>
                    ) : (
                      <div className="space-y-3">
                        <p className="text-xs font-medium text-muted-foreground/80">
                          Approval chain (pick any number per layer — any one approves to advance)
                        </p>
                        {layersAbove.map((layer) => {
                          const candidates = supervisorsAtLayerInTeam(team.id, layer)
                          const selected = cfg.chainApproverByLayer[layer] ?? []
                          const label =
                            team.layerLabels?.[layer - 1]?.trim() ||
                            `Layer ${layer}`
                          return (
                            <ChainLayerMultiPicker
                              key={layer}
                              layer={layer}
                              label={label}
                              candidates={candidates}
                              selectedIds={selected}
                              disabled={pending}
                              namePrefix={`proj.${pid}.chainApprover.${layer}`}
                              onToggle={(uid) =>
                                setProjectConfigs((prev) => {
                                  const cur = prev[pid]!.chainApproverByLayer[layer] ?? []
                                  const next = cur.includes(uid)
                                    ? cur.filter((id) => id !== uid)
                                    : [...cur, uid]
                                  return {
                                    ...prev,
                                    [pid]: {
                                      ...prev[pid]!,
                                      chainApproverByLayer: {
                                        ...prev[pid]!.chainApproverByLayer,
                                        [layer]: next,
                                      },
                                    },
                                  }
                                })
                              }
                            />
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })
            )}

            <div className="flex justify-end border-t border-border/60 pt-4">
              <Button
                type="submit"
                className="rounded-xl"
                disabled={
                  pending ||
                  activePolicies.length === 0 ||
                  !editPolicyId ||
                  selectedEditProjectIds.length === 0 ||
                  !allChainsComplete
                }
              >
                {pending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  "Save changes"
                )}
              </Button>
            </div>
          </form>
        </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
