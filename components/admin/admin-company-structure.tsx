"use client"

import { useActionState, useEffect, useMemo, useRef, useState } from "react"
import { Building2, Layers, Plus, Trash2, Users, X } from "lucide-react"

import {
  addEmployeeToProjectAction,
  assignTeamMemberAction,
  createTeamAction,
  deleteTeamAction,
  removeEmployeeFromProjectAction,
  removeTeamMemberAction,
  setProjectManagersAction,
  updateTeamAction,
  type CreateTeamActionState,
} from "@/app/(admin)/admin/company-structure/actions"
import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { useToastOnAction } from "@/components/ui/toaster"
import { cn } from "@/lib/utils"
import {
  defaultModuleConfig,
  teamModules,
  type OrganizationMember,
  type OrganizationProjectOption,
  type TeamDetail,
  type TeamModule,
  type TeamSummary,
} from "@/modules/organization/domain/models"

type Props = {
  organizationName: string
  projects: OrganizationProjectOption[]
  /// Teams now carry their member rosters inline (TeamDetail extends
  /// TeamSummary), so the inline Members panel reads them directly.
  teams: TeamDetail[]
  /// Org-wide member pool. Used as the picker source for both the
  /// project-managers picker (left column) and the team-members picker
  /// (middle column). Filtering happens client-side.
  members: OrganizationMember[]
}

export function AdminCompanyStructure({
  organizationName,
  projects,
  teams,
  members,
}: Props) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    projects[0]?.id ?? null,
  )
  const [selectedTeamId, setSelectedTeamId] = useState<string | "new" | null>(null)

  const projectsById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  )

  const teamsInSelectedProject = useMemo(
    () => teams.filter((t) => t.projectId === selectedProjectId),
    [teams, selectedProjectId],
  )

  const teamCountByProject = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of teams) {
      map.set(t.projectId, (map.get(t.projectId) ?? 0) + 1)
    }
    return map
  }, [teams])

  const selectedTeam = useMemo(() => {
    if (!selectedTeamId || selectedTeamId === "new") return null
    return teams.find((t) => t.id === selectedTeamId) ?? null
  }, [selectedTeamId, teams])

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-foreground">Company Structure</h1>
        <p className="text-sm text-muted-foreground">
          Define teams and approval layers per project for{" "}
          {organizationName || "your organization"}. Members&apos; approval chains
          are derived from the team config plus their direct supervisor — no
          per-employee overrides.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-[260px_minmax(220px,1fr)_minmax(0,2fr)]">
        {/* Projects */}
        <Card className="md:h-[480px] md:flex md:flex-col">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-4 w-4" />
              Projects
            </CardTitle>
            <CardDescription>{projects.length} total</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5 md:flex-1 md:overflow-y-auto">
            {projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Create projects in Settings first.
              </p>
            ) : (
              projects.map((project) => {
                const isActive = selectedProjectId === project.id
                const count = teamCountByProject.get(project.id) ?? 0
                return (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => {
                      setSelectedProjectId(project.id)
                      setSelectedTeamId(null)
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition",
                      isActive
                        ? "border-primary/50 bg-primary/5 text-foreground"
                        : "border-transparent hover:bg-muted/50 text-muted-foreground",
                    )}
                  >
                    <span className="truncate">{project.name}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {count}
                    </Badge>
                  </button>
                )
              })
            )}
          </CardContent>
        </Card>

        {/* Teams in selected project */}
        <Card className="md:h-[480px] md:flex md:flex-col">
          <CardHeader className="flex-row items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="h-4 w-4" />
                Teams
              </CardTitle>
              <CardDescription>
                {selectedProjectId
                  ? projectsById.get(selectedProjectId)?.name ?? ""
                  : "Pick a project"}
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={!selectedProjectId}
              onClick={() => setSelectedTeamId("new")}
              className="gap-1"
            >
              <Plus className="h-3.5 w-3.5" /> New
            </Button>
          </CardHeader>
          <CardContent className="space-y-1.5 md:flex-1 md:overflow-y-auto">
            {!selectedProjectId ? null : teamsInSelectedProject.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No teams yet. Click &ldquo;New&rdquo; to create one.
              </p>
            ) : (
              teamsInSelectedProject.map((team) => {
                const isActive = selectedTeamId === team.id
                return (
                  <button
                    key={team.id}
                    type="button"
                    onClick={() => setSelectedTeamId(team.id)}
                    className={cn(
                      "flex w-full flex-col gap-1 rounded-lg border px-3 py-2 text-left text-sm transition",
                      isActive
                        ? "border-primary/50 bg-primary/5 text-foreground"
                        : "border-transparent hover:bg-muted/50 text-muted-foreground",
                    )}
                  >
                    <span className="truncate font-medium text-foreground">
                      {team.name}
                    </span>
                    <span className="flex items-center gap-3 text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Layers className="h-3 w-3" />
                        {team.layerCount} layer{team.layerCount === 1 ? "" : "s"}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Users className="h-3 w-3" />
                        {team.memberCount} member
                        {team.memberCount === 1 ? "" : "s"}
                      </span>
                    </span>
                  </button>
                )
              })
            )}
          </CardContent>
        </Card>

        {/* Editor */}
        <div>
          {selectedTeamId === "new" && selectedProjectId ? (
            <TeamEditor
              key="new"
              mode="create"
              projectId={selectedProjectId}
              projectName={projectsById.get(selectedProjectId)?.name ?? ""}
              onCancel={() => setSelectedTeamId(null)}
              onCreated={(teamId) => setSelectedTeamId(teamId)}
            />
          ) : selectedTeam ? (
            <TeamEditor
              // Key includes a fingerprint of the saved team data so the
              // editor remounts after each successful save. Without this,
              // useState would retain stale values relative to the new
              // server-side state (e.g. if the server normalised the
              // moduleConfig, or after layerCount/layerLabels changes
              // were persisted).
              key={`${selectedTeam.id}::${selectedTeam.layerCount}::${selectedTeam.name}::${(selectedTeam.layerLabels ?? []).join("|")}::${JSON.stringify(selectedTeam.moduleConfig)}`}
              mode="edit"
              team={selectedTeam}
              projectName={
                projectsById.get(selectedTeam.projectId)?.name ?? ""
              }
              onCancel={() => setSelectedTeamId(null)}
            />
          ) : (
            <Card className="md:h-[480px]">
              <CardHeader>
                <CardTitle className="text-base">Pick a team</CardTitle>
                <CardDescription>
                  Select a team on the left to edit, or click &ldquo;New&rdquo;
                  to create one.
                </CardDescription>
              </CardHeader>
            </Card>
          )}
        </div>
      </div>

      {/* Full-width tables under the grid, stacked: project managers
          first, then team members below. Stacking gives both tables the
          full page width and keeps the manager section visually adjacent
          to the project list. */}
      {selectedProjectId || selectedTeam ? (
        <div className="space-y-4">
          {selectedProjectId ? (
            <ProjectManagersTable
              key={`pm-${selectedProjectId}`}
              project={
                projectsById.get(selectedProjectId) ?? null
              }
              members={members}
            />
          ) : null}
          {selectedTeam ? (
            <TeamMembersTable
              key={`tm-${selectedTeam.id}`}
              team={selectedTeam}
              members={members}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Team editor
// ---------------------------------------------------------------------------

type EditorProps =
  | {
      mode: "create"
      projectId: string
      projectName: string
      onCancel: () => void
      /// Called once after the create action succeeds with the new
      /// team's id, so the parent can flip selection to the freshly-
      /// created team and the editor smoothly turns into edit mode.
      onCreated?: (teamId: string) => void
    }
  | {
      mode: "edit"
      team: TeamSummary
      projectName: string
      onCancel: () => void
    }

function TeamEditor(props: EditorProps) {
  const isEdit = props.mode === "edit"
  const initialLayerCount = isEdit ? props.team.layerCount : 3
  const initialName = isEdit ? props.team.name : ""
  const initialLayerLabels = isEdit
    ? props.team.layerLabels ?? []
    : []
  const initialModuleConfig = isEdit
    ? props.team.moduleConfig
    : defaultModuleConfig(initialLayerCount)

  const [name, setName] = useState(initialName)
  const [layerCount, setLayerCount] = useState(initialLayerCount)
  const [layerLabels, setLayerLabels] = useState<string[]>(initialLayerLabels)
  const [moduleConfig, setModuleConfig] = useState(initialModuleConfig)

  // When the layer count changes, trim/extend dependent state.
  function handleLayerCountChange(next: number) {
    if (next < 1) next = 1
    if (next > 10) next = 10
    setLayerCount(next)
    setLayerLabels((labels) => labels.slice(0, next))
    setModuleConfig((cfg) => {
      const out = { ...cfg }
      for (const m of teamModules) {
        const within = (out[m] ?? []).filter((l) => l <= next)
        // When growing, keep what was there; admin can manually add new layer.
        out[m] = within
      }
      return out
    })
  }

  function toggleModuleLayer(module: TeamModule, layer: number) {
    setModuleConfig((cfg) => {
      const current = new Set(cfg[module])
      if (current.has(layer)) current.delete(layer)
      else current.add(layer)
      return {
        ...cfg,
        [module]: Array.from(current).sort((a, b) => a - b),
      }
    })
  }

  // Explicit generic so the state's `createdTeamId` shape is preserved
  // (it would be widened away by the SettingsActionState initial value).
  const [createState, createAction, createPending] = useActionState<
    CreateTeamActionState,
    FormData
  >(createTeamAction, { status: "idle", message: "" })
  const [updateState, updateAction, updatePending] = useActionState(
    updateTeamAction,
    initialSettingsActionState,
  )
  const [deleteState, deleteAction, deletePending] = useActionState(
    deleteTeamAction,
    initialSettingsActionState,
  )
  useToastOnAction(createState)
  useToastOnAction(updateState)
  useToastOnAction(deleteState)

  // Auto-flip from create-mode to edit-mode the instant the create
  // succeeds. The action returns the new team's id; we hand it off to
  // the parent so it can update `selectedTeamId`. Tracked via a ref so
  // the same id can't fire onCreated twice (React 19 may re-render the
  // editor after success without unmounting).
  const handledCreatedTeamIdRef = useRef<string | null>(null)
  const onCreated = props.mode === "create" ? props.onCreated : undefined
  useEffect(() => {
    if (createState.status !== "success") return
    if (!createState.createdTeamId) return
    if (handledCreatedTeamIdRef.current === createState.createdTeamId) return
    handledCreatedTeamIdRef.current = createState.createdTeamId
    onCreated?.(createState.createdTeamId)
  }, [createState.status, createState.createdTeamId, onCreated])

  const formAction = isEdit ? updateAction : createAction
  const pending = isEdit ? updatePending : createPending

  const layers = Array.from({ length: layerCount }, (_, i) => i + 1)

  return (
    <Card className="md:h-[480px] md:flex md:flex-col">
      <CardHeader>
        <CardTitle className="text-base">
          {isEdit ? `Edit team — ${props.team.name}` : "Create team"}
        </CardTitle>
        <CardDescription>
          Project: {props.projectName}
          {isEdit ? ` · ${props.team.memberCount} member${props.team.memberCount === 1 ? "" : "s"}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="md:flex-1 md:overflow-y-auto">
        <form action={formAction} className="space-y-6">
          {/* `hidden` attribute (in addition to type="hidden") lets
              Tailwind's space-y selector skip these inputs, so the first
              visible field doesn't get a phantom 24px top margin from
              being treated as a sibling of the hidden input. */}
          {isEdit ? (
            <input type="hidden" name="teamId" value={props.team.id} hidden />
          ) : (
            <input
              type="hidden"
              name="projectId"
              value={props.projectId}
              hidden
            />
          )}

          <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
            <div className="space-y-1.5">
              <Label htmlFor="team-name">Team name</Label>
              <Input
                id="team-name"
                name="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Operations"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="layer-count">Layers</Label>
              <Input
                id="layer-count"
                name="layerCount"
                type="number"
                min={1}
                max={10}
                value={layerCount}
                onChange={(e) =>
                  handleLayerCountChange(Number(e.target.value) || 1)
                }
                required
              />
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>Layer labels (optional)</Label>
            <p className="text-xs text-muted-foreground">
              L1 is the lowest (most junior). Labels are purely cosmetic.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {layers.map((layer) => (
                <div key={layer} className="flex items-center gap-2">
                  <span className="w-8 shrink-0 text-xs font-medium text-muted-foreground">
                    L{layer}
                  </span>
                  <Input
                    name="layerLabels"
                    placeholder={
                      layer === 1
                        ? "Staff"
                        : layer === layerCount
                        ? "Manager"
                        : `Layer ${layer}`
                    }
                    value={layerLabels[layer - 1] ?? ""}
                    onChange={(e) => {
                      const v = e.target.value
                      setLayerLabels((labels) => {
                        const next = [...labels]
                        // Pad to layer-1
                        while (next.length < layer) next.push("")
                        next[layer - 1] = v
                        return next
                      })
                    }}
                  />
                </div>
              ))}
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>Module approval config</Label>
            <p className="text-xs text-muted-foreground">
              Tick the layers that must approve for each module. By default
              every layer approves. Empty rows skip approvals entirely (use
              with caution).
            </p>
            <div className="overflow-x-auto rounded-lg border">
              <table className="min-w-full text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Module</th>
                    {layers.map((layer) => (
                      <th
                        key={layer}
                        className="px-3 py-2 text-center font-medium"
                      >
                        L{layer}
                        {layerLabels[layer - 1] ? (
                          <span className="ml-1 text-[10px] text-muted-foreground">
                            ({layerLabels[layer - 1]})
                          </span>
                        ) : null}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {teamModules.map((module) => {
                    const selected = new Set(moduleConfig[module] ?? [])
                    return (
                      <tr key={module} className="border-t">
                        <td className="px-3 py-2 font-medium text-foreground">
                          {module}
                        </td>
                        {layers.map((layer) => {
                          const checked = selected.has(layer)
                          return (
                            <td
                              key={layer}
                              className="px-3 py-2 text-center"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleModuleLayer(module, layer)}
                                className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                              />
                            </td>
                          )
                        })}
                        <td>
                          <input
                            type="hidden"
                            name={`moduleConfig.${module}`}
                            value={Array.from(selected).sort((a, b) => a - b).join(",")}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : isEdit ? "Save changes" : "Create team"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={props.onCancel}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </form>

        {/* Delete form — kept as a sibling, NOT nested inside the main
            form, since HTML forbids nested <form> elements. */}
        {isEdit ? (
          <div className="mt-4 flex justify-end border-t border-border/40 pt-4">
            <DeleteTeamButton
              teamId={props.team.id}
              pending={deletePending}
              action={deleteAction}
              disabled={props.team.memberCount > 0}
              memberCount={props.team.memberCount}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function DeleteTeamButton(props: {
  teamId: string
  pending: boolean
  action: (formData: FormData) => void
  disabled: boolean
  memberCount: number
}) {
  return (
    <form action={props.action} className="inline-flex">
      <input type="hidden" name="teamId" value={props.teamId} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        disabled={props.pending || props.disabled}
        title={
          props.disabled
            ? `Remove all ${props.memberCount} members first`
            : "Delete this team"
        }
        className="gap-1 text-destructive hover:text-destructive"
      >
        <Trash2 className="h-3.5 w-3.5" />
        Delete
      </Button>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Project managers table (full-width, below the grid)
// ---------------------------------------------------------------------------

/**
 * Full-width managers table for the selected project.
 *
 * Manager ADD is intentionally NOT exposed here — adding/removing
 * project managers is the project-settings page's job, and duplicating
 * that affordance creates two surfaces that drift. This card is
 * read-only for managers (display + remove) and write-enabled for
 * project employees (add to project, remove unassigned).
 *
 * The remove on managers stays because it's the same `setProjectManagers`
 * action either way (idempotent full-array replacement) and gives the
 * admin a fast undo when they're already on this card.
 */
function ProjectManagersTable(props: {
  project: OrganizationProjectOption | null
  members: OrganizationMember[]
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [filter, setFilter] = useState("")

  const [managerState, managerFormAction, managerPending] = useActionState(
    setProjectManagersAction,
    initialSettingsActionState,
  )
  const [employeeState, employeeFormAction, employeePending] = useActionState(
    addEmployeeToProjectAction,
    initialSettingsActionState,
  )
  const [removeEmpState, removeEmpFormAction, removeEmpPending] = useActionState(
    removeEmployeeFromProjectAction,
    initialSettingsActionState,
  )
  useToastOnAction(managerState)
  useToastOnAction(employeeState)
  useToastOnAction(removeEmpState)

  const project = props.project

  // Employee candidates: anyone (EMPLOYEE or SUPERVISOR) whose
  // `projects[]` does NOT include this project. We don't filter by
  // role here — supervisors can also be project members. Each candidate
  // must have an employeeProfileId since we key the assignment on it.
  const employeeCandidates = useMemo(() => {
    if (!project) return []
    const q = filter.trim().toLowerCase()
    return props.members.filter((m) => {
      if (!m.employeeProfileId) return false
      const inProject = m.projects.some((p) => p.id === project.id)
      if (inProject) return false
      if (!q) return true
      return (
        m.name.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q) ||
        m.employeeId.toLowerCase().includes(q)
      )
    })
  }, [props.members, project, filter])

  function buildHiddenManagerInputs(nextIds: string[]) {
    return nextIds.map((id) => (
      <input key={id} type="hidden" name="managerUserIds" value={id} />
    ))
  }

  if (!project) return null

  const managers = project.projectManagers
  const pending = managerPending || employeePending || removeEmpPending

  // Employees who are in this project but not yet on any team that
  // belongs to the project. We use member.teams[] (which carries each
  // membership's projectId) to test membership without needing the
  // teams prop here.
  const unassignedEmployees = props.members.filter((m) => {
    if (!m.employeeProfileId) return false
    const inProject = m.projects.some((p) => p.id === project.id)
    if (!inProject) return false
    const onAnyTeam = m.teams.some((t) => t.projectId === project.id)
    return !onAnyTeam
  })

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="h-4 w-4" />
            Managers — {project.name}
          </CardTitle>
          <CardDescription>
            {managers.length} manager{managers.length === 1 ? "" : "s"} · add or
            remove managers in project settings
          </CardDescription>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setPickerOpen((v) => !v)
            setFilter("")
          }}
          className="gap-1"
        >
          {pickerOpen ? (
            <X className="h-3.5 w-3.5" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          {pickerOpen ? "Close" : "Add employee"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {pickerOpen ? (
          <div className="rounded-md border border-border/60 bg-muted/30 p-2">
            <Input
              placeholder="Search employees by name, email, or employee ID…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-8 text-sm"
              autoFocus
            />
            <p className="mt-1 px-1 text-[11px] text-muted-foreground">
              Adds the employee to the project. Use the team table below to
              assign them to a specific team and layer afterwards.
            </p>
            <div className="mt-2 max-h-48 space-y-1 overflow-y-auto pr-1">
              {employeeCandidates.length === 0 ? (
                <p className="px-1 py-2 text-xs text-muted-foreground">
                  No eligible employees — everyone is already in this project.
                </p>
              ) : (
                employeeCandidates.map((c) => (
                  <form
                    key={c.id}
                    action={employeeFormAction}
                    onSubmit={() => {
                      setPickerOpen(false)
                      setFilter("")
                    }}
                  >
                    <input
                      type="hidden"
                      name="projectId"
                      value={project.id}
                    />
                    <input
                      type="hidden"
                      name="employeeProfileId"
                      value={c.employeeProfileId ?? ""}
                    />
                    <button
                      type="submit"
                      disabled={pending || !c.employeeProfileId}
                      className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-background disabled:opacity-50"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium text-foreground">
                          {c.name}
                        </span>
                        {c.role === "SUPERVISOR" ? (
                          <Badge variant="outline" className="text-[10px]">
                            Supervisor
                          </Badge>
                        ) : null}
                      </span>
                      <span className="ml-3 truncate text-xs text-muted-foreground">
                        {c.employeeId} · {c.email}
                      </span>
                    </button>
                  </form>
                ))
              )}
            </div>
          </div>
        ) : null}

        <div className="overflow-x-auto rounded-md border">
          <table className="min-w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Name</th>
                <th className="px-3 py-2 text-left font-medium">User ID</th>
                <th className="w-20 px-3 py-2 text-right font-medium">
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {managers.length === 0 ? (
                <tr>
                  <td
                    colSpan={3}
                    className="px-3 py-6 text-center text-muted-foreground"
                  >
                    No managers yet. Add one in project settings.
                  </td>
                </tr>
              ) : (
                managers.map((pm) => {
                  const remainingIds = managers
                    .map((m) => m.userId)
                    .filter((id) => id !== pm.userId)
                  return (
                    <tr key={pm.userId} className="border-t">
                      <td className="px-3 py-2 font-medium text-foreground">
                        {pm.name}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {pm.userId}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <form
                          action={managerFormAction}
                          className="inline-flex"
                        >
                          <input
                            type="hidden"
                            name="projectId"
                            value={project.id}
                          />
                          {buildHiddenManagerInputs(remainingIds)}
                          <Button
                            type="submit"
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            className="gap-1 text-muted-foreground hover:text-destructive"
                            title="Remove manager"
                          >
                            <X className="h-3.5 w-3.5" />
                            Remove
                          </Button>
                        </form>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Unassigned employees — added to the project but not on any
            team yet. Surfacing them here keeps these "stuck" rows
            visible so the admin can either assign them via the team
            members table below, or remove them if added by mistake. */}
        <div className="space-y-2 pt-2">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Unassigned employees
            </h3>
            <p className="text-xs text-muted-foreground">
              {unassignedEmployees.length === 0
                ? "Everyone in this project is assigned to a team."
                : `${unassignedEmployees.length} employee${
                    unassignedEmployees.length === 1 ? "" : "s"
                  } added to the project but not yet on any team. Use the team members table below to assign them to a layer.`}
            </p>
          </div>
          {unassignedEmployees.length > 0 ? (
            <div className="overflow-x-auto rounded-md border">
              <table className="min-w-full text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Name</th>
                    <th className="px-3 py-2 text-left font-medium">Role</th>
                    <th className="px-3 py-2 text-left font-medium">
                      Employee ID
                    </th>
                    <th className="w-24 px-3 py-2 text-right font-medium">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {unassignedEmployees.map((m) => (
                    <tr key={m.id} className="border-t">
                      <td className="px-3 py-2">
                        <div className="font-medium text-foreground">
                          {m.name}
                        </div>
                        {m.email ? (
                          <div className="text-xs text-muted-foreground">
                            {m.email}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        {m.role === "SUPERVISOR" ? (
                          <Badge variant="outline" className="text-[10px]">
                            Supervisor
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            Employee
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {m.employeeId || "—"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <form
                          action={removeEmpFormAction}
                          className="inline-flex"
                        >
                          <input
                            type="hidden"
                            name="projectId"
                            value={project.id}
                            hidden
                          />
                          <input
                            type="hidden"
                            name="employeeProfileId"
                            value={m.employeeProfileId ?? ""}
                            hidden
                          />
                          <Button
                            type="submit"
                            variant="ghost"
                            size="sm"
                            disabled={pending || !m.employeeProfileId}
                            className="gap-1 text-muted-foreground hover:text-destructive"
                            title="Remove from project"
                          >
                            <X className="h-3.5 w-3.5" />
                            Remove
                          </Button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Team members table (full-width, below the grid)
// ---------------------------------------------------------------------------

/**
 * Full-width members table for the selected team. Lists every member
 * sorted by layer (highest = most senior at the top), with a layer
 * dropdown to move them and a remove action. The "Add member" form at
 * the top picks from project members not already in the team and lets
 * the admin choose the target layer in one step.
 *
 * Layer changes use `assignTeamMemberAction` (upsert keyed on
 * (employeeProfileId, teamId)). Approval-chain rows are intentionally
 * left untouched on layer change — phase 1 keeps the existing chain and
 * lets the admin fix it via the per-employee form if it stops making
 * sense.
 */
function TeamMembersTable(props: {
  team: TeamDetail
  members: OrganizationMember[]
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [filter, setFilter] = useState("")
  const [pickerLayer, setPickerLayer] = useState<number>(1)

  const [assignState, assignAction, assignPending] = useActionState(
    assignTeamMemberAction,
    initialSettingsActionState,
  )
  const [removeState, removeAction, removePending] = useActionState(
    removeTeamMemberAction,
    initialSettingsActionState,
  )
  useToastOnAction(assignState)
  useToastOnAction(removeState)

  const layers = Array.from({ length: props.team.layerCount }, (_, i) => i + 1)
  const layersDesc = layers.slice().reverse() // high -> low for display

  const sortedMembers = useMemo(
    () =>
      [...props.team.members].sort(
        (a, b) =>
          // Layer desc, then name asc as a stable tie-break.
          b.layer - a.layer || a.name.localeCompare(b.name),
      ),
    [props.team.members],
  )

  const inTeamProfileIds = useMemo(
    () => new Set(props.team.members.map((m) => m.employeeProfileId)),
    [props.team.members],
  )

  const candidates = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return props.members.filter((m) => {
      if (!m.employeeProfileId) return false
      if (inTeamProfileIds.has(m.employeeProfileId)) return false
      const inProject = m.projects.some((p) => p.id === props.team.projectId)
      if (!inProject) return false
      if (!q) return true
      return (
        m.name.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q) ||
        m.employeeId.toLowerCase().includes(q)
      )
    })
  }, [props.members, props.team.projectId, inTeamProfileIds, filter])

  const labelFor = (layer: number) => {
    const label = props.team.layerLabels?.[layer - 1]
    return label ? `L${layer} · ${label}` : `L${layer}`
  }

  const pending = assignPending || removePending

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4" />
            Members — {props.team.name}
          </CardTitle>
          <CardDescription>
            {props.team.members.length} member
            {props.team.members.length === 1 ? "" : "s"} across{" "}
            {props.team.layerCount} layer
            {props.team.layerCount === 1 ? "" : "s"}
          </CardDescription>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setPickerOpen((v) => !v)
            setFilter("")
          }}
          className="gap-1"
        >
          {pickerOpen ? (
            <X className="h-3.5 w-3.5" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          {pickerOpen ? "Close" : "Add member"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {pickerOpen ? (
          <div className="rounded-md border border-border/60 bg-muted/30 p-2 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                placeholder="Search project members by name, email, or employee ID…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-8 flex-1 text-sm"
                autoFocus
              />
              <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <span>Add at:</span>
                <Select
                  value={String(pickerLayer)}
                  onValueChange={(v) => setPickerLayer(Number(v))}
                  disabled={pending}
                >
                  <SelectTrigger className="h-8 w-44 rounded-md border-border/60 bg-background px-3 text-sm shadow-none sm:h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {layersDesc.map((l) => (
                      <SelectItem key={l} value={String(l)}>
                        {labelFor(l)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
              {candidates.length === 0 ? (
                <p className="px-1 py-2 text-xs text-muted-foreground">
                  No eligible project members.
                </p>
              ) : (
                candidates.map((c) => (
                  <form
                    key={c.id}
                    action={assignAction}
                    onSubmit={() => {
                      setPickerOpen(false)
                      setFilter("")
                    }}
                  >
                    <input
                      type="hidden"
                      name="teamId"
                      value={props.team.id}
                    />
                    <input
                      type="hidden"
                      name="employeeProfileId"
                      value={c.employeeProfileId ?? ""}
                    />
                    <input type="hidden" name="layer" value={pickerLayer} />
                    <button
                      type="submit"
                      disabled={pending || !c.employeeProfileId}
                      className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-background disabled:opacity-50"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium text-foreground">
                          {c.name}
                        </span>
                        {c.role === "SUPERVISOR" ? (
                          <Badge variant="outline" className="text-[10px]">
                            Supervisor
                          </Badge>
                        ) : null}
                      </span>
                      <span className="ml-3 truncate text-xs text-muted-foreground">
                        {c.employeeId} · {c.email}
                      </span>
                    </button>
                  </form>
                ))
              )}
            </div>
          </div>
        ) : null}

        <div className="overflow-x-auto rounded-md border">
          <table className="min-w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Name</th>
                <th className="px-3 py-2 text-left font-medium">Role</th>
                <th className="px-3 py-2 text-left font-medium">Employee ID</th>
                <th className="w-32 px-3 py-2 text-left font-medium">Layer</th>
                <th className="w-24 px-3 py-2 text-right font-medium">
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedMembers.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-3 py-6 text-center text-muted-foreground"
                  >
                    No members yet. Click &ldquo;Add member&rdquo; to assign
                    one.
                  </td>
                </tr>
              ) : (
                sortedMembers.map((m) => {
                  // Find the source member entry to get email + employeeId
                  // for richer table rows. Fall back to the membership
                  // payload when not found (e.g. recently-deleted user).
                  const fromOrg = props.members.find(
                    (om) => om.employeeProfileId === m.employeeProfileId,
                  )
                  return (
                    <tr key={m.id} className="border-t">
                      <td className="px-3 py-2">
                        <div className="font-medium text-foreground">
                          {m.name}
                        </div>
                        {fromOrg?.email ? (
                          <div className="text-xs text-muted-foreground">
                            {fromOrg.email}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        {m.role === "SUPERVISOR" ? (
                          <Badge variant="outline" className="text-[10px]">
                            Supervisor
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            Employee
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {fromOrg?.employeeId ?? "—"}
                      </td>
                      <td className="px-3 py-2">
                        {/* Layer change uses the shadcn Select for visual
                            consistency. Radix Select isn't a native form
                            element, so we call the action imperatively
                            (formAction is callable with FormData) instead
                            of relying on form submission. */}
                        <Select
                          value={String(m.layer)}
                          onValueChange={(v) => {
                            // No-op when the user re-picks the current
                            // value. Avoids burning a network round-trip
                            // on a no-change interaction.
                            if (Number(v) === m.layer) return
                            const fd = new FormData()
                            fd.append("teamId", props.team.id)
                            fd.append("employeeProfileId", m.employeeProfileId)
                            fd.append("layer", v)
                            assignAction(fd)
                          }}
                          disabled={pending}
                        >
                          <SelectTrigger
                            className="h-8 w-40 rounded-md border-border/60 bg-background px-3 text-xs shadow-none sm:h-8 sm:text-xs"
                            title="Change layer"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {layersDesc.map((l) => (
                              <SelectItem key={l} value={String(l)}>
                                {labelFor(l)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <form
                          action={removeAction}
                          className="inline-flex"
                        >
                          <input
                            type="hidden"
                            name="membershipId"
                            value={m.id}
                          />
                          <Button
                            type="submit"
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            className="gap-1 text-muted-foreground hover:text-destructive"
                            title="Remove from team"
                          >
                            <X className="h-3.5 w-3.5" />
                            Remove
                          </Button>
                        </form>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}
