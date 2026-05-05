"use client"

import { useActionState, useMemo, useState } from "react"
import { Building2, Layers, Plus, Trash2, Users } from "lucide-react"

import {
  createTeamAction,
  deleteTeamAction,
  updateTeamAction,
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
import { Separator } from "@/components/ui/separator"
import { useToastOnAction } from "@/components/ui/toaster"
import { cn } from "@/lib/utils"
import {
  defaultModuleConfig,
  teamModules,
  type OrganizationProjectOption,
  type TeamModule,
  type TeamSummary,
} from "@/modules/organization/domain/models"

type Props = {
  organizationName: string
  projects: OrganizationProjectOption[]
  teams: TeamSummary[]
}

export function AdminCompanyStructure({ organizationName, projects, teams }: Props) {
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
        <Card className="md:max-h-[calc(100vh-180px)] md:overflow-y-auto">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-4 w-4" />
              Projects
            </CardTitle>
            <CardDescription>{projects.length} total</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
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
        <Card className="md:max-h-[calc(100vh-180px)] md:overflow-y-auto">
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
          <CardContent className="space-y-1.5">
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
            <Card>
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

  const [createState, createAction, createPending] = useActionState(
    createTeamAction,
    initialSettingsActionState,
  )
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

  const formAction = isEdit ? updateAction : createAction
  const pending = isEdit ? updatePending : createPending

  const layers = Array.from({ length: layerCount }, (_, i) => i + 1)

  return (
    <Card className="md:max-h-[calc(100vh-180px)] md:overflow-y-auto">
      <CardHeader>
        <CardTitle className="text-base">
          {isEdit ? `Edit team — ${props.team.name}` : "Create team"}
        </CardTitle>
        <CardDescription>
          Project: {props.projectName}
          {isEdit ? ` · ${props.team.memberCount} member${props.team.memberCount === 1 ? "" : "s"}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-6">
          {isEdit ? (
            <input type="hidden" name="teamId" value={props.team.id} />
          ) : (
            <input type="hidden" name="projectId" value={props.projectId} />
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
