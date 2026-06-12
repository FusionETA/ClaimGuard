"use client"

import { useActionState, useEffect, useMemo, useRef, useState } from "react"
import { Building2, Layers, Plus, Search, Trash2, Users, X } from "lucide-react"

import {
  assignTeamMemberAction,
  createTeamAction,
  deleteTeamAction,
  removeTeamMemberAction,
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
import { ScrollArea } from "@/components/ui/scroll-area"
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
  // Client-side search for the Projects and Teams columns. Both are
  // case-insensitive substring matches against the entity name; we
  // keep the lowercased term in a ref-free derivation rather than a
  // state to keep the filtering pure on every render.
  const [projectSearch, setProjectSearch] = useState("")
  const [teamSearch, setTeamSearch] = useState("")

  const projectsById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  )

  const teamCountByProject = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of teams) {
      map.set(t.projectId, (map.get(t.projectId) ?? 0) + 1)
    }
    return map
  }, [teams])

  // Projects with teams sort to the top of the left-column list —
  // those are the ones the admin actually configures structure for.
  // Empty projects drop below so they stay accessible but out of the
  // way. Within each group, preserve the server's alphabetical order.
  // Stable sort: same teamCount → original index order.
  const filteredProjects = useMemo(() => {
    const q = projectSearch.trim().toLowerCase()
    const base =
      q === ""
        ? projects
        : projects.filter((p) => p.name.toLowerCase().includes(q))
    return base
      .map((p, idx) => ({
        project: p,
        idx,
        hasTeams: (teamCountByProject.get(p.id) ?? 0) > 0,
      }))
      .sort((a, b) => {
        if (a.hasTeams !== b.hasTeams) return a.hasTeams ? -1 : 1
        return a.idx - b.idx
      })
      .map((x) => x.project)
  }, [projects, projectSearch, teamCountByProject])

  const teamsInSelectedProject = useMemo(
    () => teams.filter((t) => t.projectId === selectedProjectId),
    [teams, selectedProjectId],
  )

  const filteredTeamsInSelectedProject = useMemo(() => {
    const q = teamSearch.trim().toLowerCase()
    if (q === "") return teamsInSelectedProject
    return teamsInSelectedProject.filter((t) =>
      t.name.toLowerCase().includes(q),
    )
  }, [teamsInSelectedProject, teamSearch])

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
          <CardContent className="md:flex md:flex-1 md:flex-col md:overflow-hidden">
            {projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Create projects in Settings first.
              </p>
            ) : (
              <>
                {/* Search bar — fixed above the scrollable list so it
                    stays visible while the list scrolls. Only shown
                    once the project count exceeds ~5 so small orgs
                    don't see clutter; threshold is intentionally low
                    so it kicks in early as the list grows. */}
                {projects.length > 5 ? (
                  <div className="relative mt-1 mb-3">
                    <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder="Search projects…"
                      value={projectSearch}
                      onChange={(e) => setProjectSearch(e.target.value)}
                      className="h-9 pl-8 text-sm"
                    />
                  </div>
                ) : null}
                <div className="space-y-1.5 md:flex-1 md:overflow-y-auto">
                  {filteredProjects.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-muted-foreground">
                      No project matches that search.
                    </p>
                  ) : (
                    filteredProjects.map((project) => {
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
                </div>
              </>
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
          <CardContent className="md:flex md:flex-1 md:flex-col md:overflow-hidden">
            {!selectedProjectId ? null : teamsInSelectedProject.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No teams yet. Click &ldquo;New&rdquo; to create one.
              </p>
            ) : (
              <>
                {teamsInSelectedProject.length > 5 ? (
                  <div className="relative mt-1 mb-3">
                    <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder="Search teams…"
                      value={teamSearch}
                      onChange={(e) => setTeamSearch(e.target.value)}
                      className="h-9 pl-8 text-sm"
                    />
                  </div>
                ) : null}
                <div className="space-y-1.5 md:flex-1 md:overflow-y-auto">
                  {filteredTeamsInSelectedProject.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-muted-foreground">
                      No team matches that search.
                    </p>
                  ) : (
                    filteredTeamsInSelectedProject.map((team) => {
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
                </div>
              </>
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

      {/* Per-team members card. Adding a member to a team implicitly
          puts them in the team's parent project — admins don't need a
          separate "add to project" step. (The old project-level
          managers card was removed when we collapsed that flow.) */}
      {selectedTeam ? (
        <TeamMembersTable
          key={`tm-${selectedTeam.id}`}
          team={selectedTeam}
          members={members}
        />
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
  // Per-event attendance approval gates. Default true so new teams behave
  // like before (every clock/break event needs approval).
  const [requireClockInApproval, setRequireClockInApproval] = useState(
    isEdit ? props.team.requireClockInApproval : true,
  )
  const [requireClockOutApproval, setRequireClockOutApproval] = useState(
    isEdit ? props.team.requireClockOutApproval : true,
  )
  const [requireBreakStartApproval, setRequireBreakStartApproval] = useState(
    isEdit ? props.team.requireBreakStartApproval : true,
  )
  const [requireBreakEndApproval, setRequireBreakEndApproval] = useState(
    isEdit ? props.team.requireBreakEndApproval : true,
  )

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
              every layer approves. Empty columns skip approvals entirely
              (use with caution).
            </p>
            <ScrollArea className="overflow-x-auto rounded-lg border">
              {/*
                Transposed view: each LAYER is a row and each MODULE is a
                column. This matches the way the admin tends to reason
                about a team — "what does L1 approve?" — and keeps the
                table narrower as more modules are added than layers in
                a typical team.

                The submitted form payload is unchanged: still one hidden
                input per module with comma-separated layer numbers. The
                inputs are rendered once at the bottom of this block (not
                inside the table) so the table layout stays tidy.
              */}
              <table className="min-w-full text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Layer</th>
                    {teamModules.map((module) => (
                      <th
                        key={module}
                        className="px-3 py-2 text-center font-medium"
                      >
                        {module}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {layers.map((layer) => (
                    <tr key={layer} className="border-t">
                      <td className="px-3 py-2 font-medium text-foreground">
                        L{layer}
                        {layerLabels[layer - 1] ? (
                          <span className="ml-1 text-[10px] text-muted-foreground">
                            ({layerLabels[layer - 1]})
                          </span>
                        ) : null}
                      </td>
                      {teamModules.map((module) => {
                        const selected = new Set(moduleConfig[module] ?? [])
                        const checked = selected.has(layer)
                        return (
                          <td
                            key={module}
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollArea>
            {/* Hidden inputs — one per module, comma-separated sorted
                layer numbers. The form action reads these keys to
                reconstruct the moduleConfig map. Rendering them outside
                the table avoids stray <input> elements inside <td>
                cells (which validators flag). */}
            {teamModules.map((module) => {
              const selected = new Set(moduleConfig[module] ?? [])
              return (
                <input
                  key={module}
                  type="hidden"
                  name={`moduleConfig.${module}`}
                  value={Array.from(selected).sort((a, b) => a - b).join(",")}
                />
              )
            })}
          </div>

          {/* Per-event attendance approval gates. Each toggle decides whether
              the corresponding event flows through the ATTENDANCE chain
              above (when checked) or auto-approves on creation (when
              unchecked). Break is split by `breakSubtype` even though the
              underlying ApprovalKind stays "BREAK". */}
          <div className="space-y-3 rounded-lg border bg-card/60 p-4">
            <div>
              <p className="text-sm font-semibold text-foreground">
                Attendance approval per event
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Tick which events still need supervisor approval. Unchecked
                events auto-approve on creation (no chain) — useful for teams
                where, say, clock-out should be silent but clock-in is
                reviewed. Applies on top of the ATTENDANCE layer config above.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex items-center gap-2 rounded-md border border-border/70 bg-surface-low px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                <input
                  type="checkbox"
                  name="requireClockInApproval"
                  checked={requireClockInApproval}
                  onChange={(e) => setRequireClockInApproval(e.target.checked)}
                  disabled={pending}
                  className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                />
                <span className="font-medium text-foreground">
                  Clock in
                </span>
              </label>
              <label className="flex items-center gap-2 rounded-md border border-border/70 bg-surface-low px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                <input
                  type="checkbox"
                  name="requireClockOutApproval"
                  checked={requireClockOutApproval}
                  onChange={(e) => setRequireClockOutApproval(e.target.checked)}
                  disabled={pending}
                  className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                />
                <span className="font-medium text-foreground">
                  Clock out
                </span>
              </label>
              <label className="flex items-center gap-2 rounded-md border border-border/70 bg-surface-low px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                <input
                  type="checkbox"
                  name="requireBreakStartApproval"
                  checked={requireBreakStartApproval}
                  onChange={(e) => setRequireBreakStartApproval(e.target.checked)}
                  disabled={pending}
                  className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                />
                <span className="font-medium text-foreground">
                  Break start
                </span>
              </label>
              <label className="flex items-center gap-2 rounded-md border border-border/70 bg-surface-low px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                <input
                  type="checkbox"
                  name="requireBreakEndApproval"
                  checked={requireBreakEndApproval}
                  onChange={(e) => setRequireBreakEndApproval(e.target.checked)}
                  disabled={pending}
                  className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                />
                <span className="font-medium text-foreground">
                  Break end
                </span>
              </label>
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

  // Picker shows every org employee with a profile (minus those
  // already in THIS team). Project-membership is no longer a
  // pre-requisite — `assignTeamMember` on the server side now
  // upserts the EmployeeProjectAssignment alongside the team
  // membership, so adding to a team implicitly puts the employee in
  // the project too. That collapses the old two-step flow ("add to
  // project, then add to team") into a single click.
  const candidates = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return props.members.filter((m) => {
      if (!m.employeeProfileId) return false
      if (inTeamProfileIds.has(m.employeeProfileId)) return false
      if (!q) return true
      return (
        m.name.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q) ||
        m.employeeId.toLowerCase().includes(q)
      )
    })
  }, [props.members, inTeamProfileIds, filter])

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
                placeholder="Search employees by name, email, or employee ID…"
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
                  No eligible employees.
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

        <ScrollArea className="overflow-x-auto rounded-md border">
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
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
