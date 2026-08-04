"use client"

import { useActionState, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { CheckSquare, ChevronDown, Loader2, Plus, Search, Square } from "lucide-react"

import { createInitialHierarchyFormState } from "@/app/(admin)/admin/hierarchy/form-state"
import { updateHierarchyAction } from "@/app/(admin)/admin/hierarchy/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useToast } from "@/components/ui/toaster"
import { cn } from "@/lib/utils"
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

export type EmployeeCompanyData = {
  member: OrganizationMember
  projects: OrganizationProjectOption[]
  /// The org's single Xero connection (1:1 with the organization). Used
  /// only to scope which projects are offered + sent as a hidden field
  /// so the action keeps the existing member link. Not shown in the UI —
  /// the Xero org is fixed per company, not per employee.
  xeroConnection: XeroConnectionInfo | undefined
  teams: TeamSummary[]
  allMembers: OrganizationMember[]
  policies: EmployeePolicy[]
  /// Stored review/checkpoint date (ISO yyyy-mm-dd) used when the
  /// employee's policy is temporary. The field below is conditionally
  /// rendered + persisted via the same hierarchy save action that owns
  /// the policy assignment, so policy + review-date stay in lock-step.
  temporaryReviewDate: string | null
}

function resolveSelectedProjectIds(
  memberProjects: OrganizationMember["projects"],
  availableProjects: OrganizationProjectOption[],
) {
  const availableById = new Set(availableProjects.map((project) => project.id))
  const availableByName = new Map(
    availableProjects.map((project) => [project.name, project.id]),
  )

  return memberProjects
    .map((project) => {
      if (availableById.has(project.id)) return project.id
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
}: {
  inputName: string
  projects: OrganizationProjectOption[]
  selectedProjectIds: string[]
  onToggle: (projectId: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const containerRef = useRef<HTMLDivElement | null>(null)
  const selectedProjects = projects.filter((project) =>
    selectedProjectIds.includes(project.id),
  )
  const triggerLabel =
    selectedProjects.length > 0
      ? selectedProjects.map((project) => project.name).join(", ")
      : "Select project(s)"

  // Selected projects float to the top of the list; a case-insensitive
  // name search filters both groups. Kept as two arrays so we can drop a
  // divider between "picked" and "the rest".
  const q = query.trim().toLowerCase()
  const matchesQuery = (project: OrganizationProjectOption) =>
    q.length === 0 || project.name.toLowerCase().includes(q)
  const selectedMatches = projects.filter(
    (project) => selectedProjectIds.includes(project.id) && matchesQuery(project),
  )
  const unselectedMatches = projects.filter(
    (project) => !selectedProjectIds.includes(project.id) && matchesQuery(project),
  )
  const renderRow = (project: OrganizationProjectOption) => {
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
  }

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener("mousedown", handlePointerDown)
    return () => document.removeEventListener("mousedown", handlePointerDown)
  }, [open])

  // Clear the search each time the panel opens so it never reopens
  // pre-filtered from a previous session.
  useEffect(() => {
    if (open) setQuery("")
  }, [open])

  return (
    <div
      ref={containerRef}
      className="relative space-y-2 text-sm font-semibold text-muted-foreground"
    >
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
              {/* Sticky search — Enter is swallowed so it never submits the
                  surrounding employee form; Escape closes the panel. */}
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  autoFocus
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.preventDefault()
                    if (event.key === "Escape") setOpen(false)
                  }}
                  placeholder="Search projects…"
                  className="h-9 w-full rounded-xl border border-border/70 bg-surface-low pl-9 pr-3 text-sm text-foreground outline-none transition focus:border-primary/50"
                />
              </div>
              <div className="nice-scrollbar max-h-64 space-y-1 overflow-y-auto">
                {selectedMatches.length === 0 && unselectedMatches.length === 0 ? (
                  <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                    No projects match &ldquo;{query.trim()}&rdquo;.
                  </p>
                ) : (
                  <>
                    {selectedMatches.map(renderRow)}
                    {selectedMatches.length > 0 && unselectedMatches.length > 0 ? (
                      <div className="my-1 h-px bg-border/60" role="separator" />
                    ) : null}
                    {unselectedMatches.map(renderRow)}
                  </>
                )}
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex h-12 w-full items-center rounded-2xl border border-border/80 bg-card px-4 text-sm text-muted-foreground shadow-sm">
          No projects available yet
        </div>
      )}
    </div>
  )
}

/**
 * Per-layer multi-select supervisor picker. Emits one hidden input per
 * selected userId under `namePrefix` (e.g. `proj.<pid>.chainApprover.2`);
 * the action reads them via formData.entries().
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
        <span className="ml-1 font-normal text-muted-foreground/70">— {label}</span>
      </label>
      {candidates.length === 0 ? (
        <div className="flex h-12 w-full items-center rounded-2xl border border-border/80 bg-card px-4 text-sm text-muted-foreground shadow-sm">
          No L{layer} supervisors in this team
        </div>
      ) : (
        <div className="max-h-[200px] overflow-y-auto rounded-2xl border border-border/80 bg-card p-2 shadow-sm">
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
      {selectedIds.map((userId) => (
        <input key={userId} type="hidden" name={namePrefix} value={userId} />
      ))}
    </div>
  )
}

/**
 * Inline "Company" form — the org-hierarchy editor (role, job title,
 * policy, projects, per-project team + approval chain, Xero org) ported
 * out of the old hierarchy edit dialog so it can live as a tab on the
 * unified employee detail page. Saves via updateHierarchyAction.
 */
export function EmployeeCompanyForm({
  member,
  projects,
  xeroConnection,
  teams,
  allMembers,
  policies,
  temporaryReviewDate: initialTemporaryReviewDate,
}: EmployeeCompanyData) {
  const [payrollCostProjectId, setPayrollCostProjectId] = useState<string>(
    member.payrollCostProjectId ?? "",
  )
  const { toast } = useToast()
  const router = useRouter()
  const xeroConnectionId = xeroConnection?.id ?? ""
  const initialState = useMemo(
    () =>
      createInitialHierarchyFormState({
        role: member.role,
        organizationId: member.organizationId ?? "",
        jobTitle: member.jobTitle,
        xeroConnectionId,
      }),
    [member, xeroConnectionId],
  )
  const [state, formAction, pending] = useActionState(
    updateHierarchyAction,
    initialState,
  )

  const [roleValue, setRoleValue] = useState<"EMPLOYEE" | "SUPERVISOR">(member.role)
  const activePolicies = useMemo(
    () => policies.filter((p) => !p.archived),
    [policies],
  )
  const fallbackPolicyId = useMemo(
    () => activePolicies.find((p) => p.isDefault)?.id ?? activePolicies[0]?.id ?? "",
    [activePolicies],
  )
  const [policyId, setPolicyId] = useState<string>(member.policyId ?? fallbackPolicyId)
  const selectedPolicy = activePolicies.find((p) => p.id === policyId)
  const [temporaryReviewDate, setTemporaryReviewDate] = useState<string>(
    initialTemporaryReviewDate ?? "",
  )
  // The review date is mandatory when (and only when) the selected
  // policy is temporary. Save is blocked client-side AND validated
  // server-side in updateHierarchyAction.
  const needsTemporaryReviewDate = Boolean(selectedPolicy?.temporary)
  const temporaryReviewDateMissing =
    needsTemporaryReviewDate && temporaryReviewDate.trim() === ""

  const filteredProjects = useMemo(
    () =>
      xeroConnectionId
        ? projects.filter(
            (p) => !p.xeroConnectionId || p.xeroConnectionId === xeroConnectionId,
          )
        : projects,
    [projects, xeroConnectionId],
  )
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>(() =>
    resolveSelectedProjectIds(member.projects, filteredProjects),
  )

  // Cost-project dropdown options are exactly the projects currently
  // ticked above — you can only charge salary to a project the
  // employee is assigned to.
  const selectedCostProjectOptions = useMemo(
    () => filteredProjects.filter((p) => selectedProjectIds.includes(p.id)),
    [filteredProjects, selectedProjectIds],
  )

  // If the admin unticks the project that was chosen as the cost
  // project, clear the pick so we don't submit a stale id (the repo
  // would null it anyway, but keeping the UI honest avoids a
  // confusing "saved" state that silently reverted).
  useEffect(() => {
    if (
      payrollCostProjectId &&
      !selectedProjectIds.includes(payrollCostProjectId)
    ) {
      setPayrollCostProjectId("")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectIds.join(",")])

  // Default approval chain for a (team, layer): every layer ABOVE the employee
  // is pre-filled with that layer's supervisors (any one of them can approve to
  // advance). Used so a member added via the company structure shows their
  // supervisors auto-selected here instead of a blank chain.
  const defaultChainApprovers = (
    teamId: string,
    layer: number,
  ): Record<number, string[]> => {
    const team = teams.find((t) => t.id === teamId)
    if (!team) return {}
    const out: Record<number, string[]> = {}
    for (let l = layer + 1; l <= team.layerCount; l++) {
      const sup = allMembers
        .filter(
          (m) =>
            m.id !== member.id &&
            m.role === "SUPERVISOR" &&
            m.teams.some((t) => t.teamId === teamId && t.layer === l),
        )
        .map((m) => m.id)
      if (sup.length) out[l] = sup
    }
    return out
  }

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
      // No saved chain yet (e.g. just added via company structure) → auto-fill
      // each higher layer with that layer's supervisors.
      const chain = Object.keys(map).length
        ? map
        : defaultChainApprovers(t.teamId, t.layer)
      out[t.projectId] = { teamId: t.teamId, layer: t.layer, chainApproverByLayer: chain }
    }
    return out
  })

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
  ): OrganizationMember[] =>
    allMembers.filter(
      (m) =>
        m.id !== member.id &&
        m.role === "SUPERVISOR" &&
        m.teams.some((t) => t.teamId === teamId && t.layer === layer),
    )

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
      router.refresh()
    }
    if (state.status === "error" && state.message) {
      toast({ title: state.message, variant: "error" })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Prune configs for unselected projects; seed placeholders for new ones.
  useEffect(() => {
    setProjectConfigs((prev) => {
      const out: typeof prev = {}
      for (const pid of selectedProjectIds) {
        out[pid] = prev[pid] ?? { teamId: "", layer: 1, chainApproverByLayer: {} }
      }
      return out
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectIds.join(",")])

  return (
    <form
      action={formAction}
      className="space-y-5 rounded-[28px] border border-border/70 bg-card/90 p-5 shadow-sm"
    >
      <input type="hidden" name="userId" value={member.id} />
      <input type="hidden" name="email" value={member.email} />
      <input type="hidden" name="xeroConnectionId" value={xeroConnectionId} />

      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 text-sm font-semibold text-muted-foreground">
            <label htmlFor={`company-role-${member.id}`}>Role</label>
            <Select
              name="role"
              value={roleValue}
              onValueChange={(value) =>
                setRoleValue(value as "EMPLOYEE" | "SUPERVISOR")
              }
              disabled={pending}
            >
              <SelectTrigger id={`company-role-${member.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="EMPLOYEE">Non-supervisory employee</SelectItem>
                <SelectItem value="SUPERVISOR">Supervisor</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <label className="space-y-2 text-sm font-semibold text-muted-foreground">
            <span>Job title</span>
            <Input name="jobTitle" defaultValue={state.values.jobTitle} disabled={pending} />
          </label>
        </div>

        <div className="space-y-2 text-sm font-semibold text-muted-foreground">
          <label htmlFor={`company-policy-${member.id}`}>Employee policy</label>
          <input type="hidden" name="policyId" value={policyId} />
          {activePolicies.length > 0 ? (
            <Select
              value={policyId}
              onValueChange={(v) => setPolicyId(v)}
              disabled={pending}
            >
              <SelectTrigger id={`company-policy-${member.id}`}>
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
          {selectedPolicy ? (
            <p className="text-xs font-normal text-muted-foreground">
              {employeePayoutMethodLabels[selectedPolicy.salaryType]} ·{" "}
              {selectedPolicy.otEnabled
                ? `OT paid as ${otPayoutMethodLabels[selectedPolicy.otMethod].toLowerCase()}`
                : "OT disabled"}
              {roleValue === "SUPERVISOR"
                ? " · supervisors are always paid monthly"
                : ""}
            </p>
          ) : null}

          {needsTemporaryReviewDate ? (
            <div className="space-y-2 pt-1">
              <label
                htmlFor={`temporary-review-${member.id}`}
                className="text-sm font-semibold text-muted-foreground"
              >
                Temporary review date{" "}
                <span className="text-destructive">*</span>
              </label>
              <Input
                id={`temporary-review-${member.id}`}
                name="temporaryReviewDate"
                type="date"
                value={temporaryReviewDate}
                onChange={(e) => setTemporaryReviewDate(e.target.value)}
                required
                aria-invalid={temporaryReviewDateMissing || undefined}
                disabled={pending}
              />
              <p className="text-xs font-normal text-muted-foreground">
                This policy is marked temporary. Admins are reminded to
                revisit this employee&apos;s classification when the date
                arrives.
              </p>
            </div>
          ) : null}
        </div>

        <div className="space-y-2 text-sm font-semibold text-muted-foreground">
          <label>Projects</label>
          <ProjectMultiSelect
            inputName="projectIds"
            projects={filteredProjects}
            selectedProjectIds={selectedProjectIds}
            disabled={pending}
            onToggle={(projectId) =>
              setSelectedProjectIds((current) =>
                current.includes(projectId)
                  ? current.filter((id) => id !== projectId)
                  : [...current, projectId],
              )
            }
          />
        </div>

        {/* Salary cost project — only relevant when the employee is on
            2+ projects. Picks which project their salary + employer
            statutory cost is charged to in the Xero payroll journal.
            "First project (default)" leaves it unset, so the sync
            falls back to the first assignment. */}
        {selectedProjectIds.length >= 2 ? (
          <div className="space-y-2 text-sm font-semibold text-muted-foreground">
            <label htmlFor={`cost-project-${member.id}`}>
              Salary charges to
            </label>
            <input
              type="hidden"
              name="payrollCostProjectId"
              value={payrollCostProjectId}
            />
            <Select
              value={payrollCostProjectId || "__default__"}
              onValueChange={(v) =>
                setPayrollCostProjectId(v === "__default__" ? "" : v)
              }
              disabled={pending}
            >
              <SelectTrigger id={`cost-project-${member.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">First project (default)</SelectItem>
                {selectedCostProjectOptions.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs font-normal text-muted-foreground">
              Which project this employee&apos;s salary and employer EPF /
              SOCSO cost posts to in the payroll journal.
            </p>
          </div>
        ) : null}
      </div>

      {/* Per-project team + chain configuration. */}
      {selectedProjectIds.length === 0 ? (
        <div className="rounded-[28px] border border-dashed border-border/70 bg-card/40 p-5 text-sm text-muted-foreground">
          Pick at least one project above.
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
                <p className="text-sm font-semibold text-foreground">{project.name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground/70">
                  Team and approval chain for this project.
                </p>
              </div>

              <input type="hidden" name={`proj.${pid}.teamId`} value={cfg.teamId} />
              <input type="hidden" name={`proj.${pid}.layer`} value={String(cfg.layer)} />

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 text-sm font-semibold text-muted-foreground">
                  <label htmlFor={`company-team-${member.id}-${pid}`}>Team</label>
                  <Select
                    value={cfg.teamId || undefined}
                    onValueChange={(v) =>
                      setProjectConfigs((prev) => ({
                        ...prev,
                        [pid]: {
                          teamId: v,
                          layer: 1,
                          chainApproverByLayer: defaultChainApprovers(v, 1),
                        },
                      }))
                    }
                    disabled={pending}
                  >
                    <SelectTrigger id={`company-team-${member.id}-${pid}`}>
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
                          {t.name} · {t.layerCount} layer
                          {t.layerCount === 1 ? "" : "s"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {roleValue === "SUPERVISOR" && team ? (
                  <div className="space-y-2 text-sm font-semibold text-muted-foreground">
                    <label htmlFor={`company-layer-${member.id}-${pid}`}>
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
                            chainApproverByLayer: defaultChainApprovers(
                              prev[pid]!.teamId,
                              Number(v) || 1,
                            ),
                          },
                        }))
                      }
                      disabled={pending}
                    >
                      <SelectTrigger id={`company-layer-${member.id}-${pid}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: team.layerCount }, (_, i) => i + 1).map(
                          (layer) => {
                            const label =
                              team.layerLabels?.[layer - 1]?.trim() || `Layer ${layer}`
                            return (
                              <SelectItem key={layer} value={String(layer)}>
                                L{layer} — {label}
                              </SelectItem>
                            )
                          },
                        )}
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
                  This employee is at the top layer — nobody approves above them in
                  this project.
                </p>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs font-medium text-muted-foreground/80">
                    Approval chain (pick any number per layer — any one approves to
                    advance)
                  </p>
                  {layersAbove.map((layer) => {
                    const candidates = supervisorsAtLayerInTeam(team.id, layer)
                    const selected = cfg.chainApproverByLayer[layer] ?? []
                    const label =
                      team.layerLabels?.[layer - 1]?.trim() || `Layer ${layer}`
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
          // Projects + chains are NOT in this gate. An admin should be
          // able to save the policy / role / job title in one pass and
          // come back later for project assignments + approval chains.
          // The Company tab pill stays "Required fields missing" until
          // those are added — readiness check lives in the badge logic,
          // not the Save button. Bare minimum to save: policy picked
          // (so payroll has a salary type to fall back on) and no
          // temporary-employee deadline is overdue.
          disabled={
            pending ||
            activePolicies.length === 0 ||
            !policyId ||
            temporaryReviewDateMissing
          }
        >
          {pending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving…
            </>
          ) : (
            "Save Company"
          )}
        </Button>
      </div>
    </form>
  )
}
