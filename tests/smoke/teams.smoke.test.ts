import { afterAll, beforeAll, expect, it } from "vitest"

import {
  apiDelete,
  apiGet,
  apiPost,
  describeSmoke,
  isSmokeName,
  tag,
} from "./helpers/client"

/**
 * Teams API smoke — full create → read → delete lifecycle.
 *
 * A team belongs to a project, so we stand up a throwaway parent project
 * in beforeAll and tear both down in reverse order. Member add/remove is
 * intentionally excluded (a team with members refuses deletion), keeping
 * the fixture self-cleaning. Scopes used: teams:read/write + projects:read/write.
 */

type CreatedProject = { data: { id: string; name: string } | null }
type CreatedTeam = {
  data: {
    id: string
    name: string
    projectId: string
    layerCount: number
    memberCount: number
  }
}
type TeamDetail = {
  data: {
    id: string
    name: string
    projectId: string
    layerCount: number
    members: unknown[]
  }
}
type TeamList = { data: Array<{ id: string }>; total: number }
type DeleteResult = { ok?: boolean }

describeSmoke("teams API smoke", () => {
  let projectId: string | null = null
  let teamId: string | null = null

  beforeAll(async () => {
    const project = await apiPost<CreatedProject>("/api/v1/projects", {
      name: tag("Team Parent Project"),
    })
    expect(project.status, "create parent project").toBe(201)
    projectId = project.body.data?.id ?? null
    expect(projectId).toBeTruthy()
  })

  afterAll(async () => {
    // Reverse order: team first (a project with teams may refuse delete),
    // then the parent project. Guarded so a mid-test delete doesn't double-fire.
    if (teamId) await apiDelete(`/api/v1/teams/${teamId}`)
    if (projectId) await apiDelete(`/api/v1/projects/${projectId}`)
  })

  it("creates, reads, and deletes a team under a project", async () => {
    expect(projectId).toBeTruthy()

    const name = tag("Team")
    const created = await apiPost<CreatedTeam>("/api/v1/teams", {
      projectId,
      name,
      layerCount: 1,
    })
    expect(created.status, "create team").toBe(201)
    expect(created.body.data.id).toBeTruthy()
    expect(created.body.data.projectId).toBe(projectId)
    expect(created.body.data.layerCount).toBe(1)
    expect(created.body.data.memberCount).toBe(0)
    expect(isSmokeName(created.body.data.name)).toBe(true)
    teamId = created.body.data.id

    // Read it back with its (empty) member list.
    const fetched = await apiGet<TeamDetail>(`/api/v1/teams/${teamId}`)
    expect(fetched.status).toBe(200)
    expect(fetched.body.data.id).toBe(teamId)
    expect(Array.isArray(fetched.body.data.members)).toBe(true)
    expect(fetched.body.data.members.length).toBe(0)

    // Filtered list should include our team.
    const list = await apiGet<TeamList>(`/api/v1/teams?projectId=${projectId}`)
    expect(list.status).toBe(200)
    expect(typeof list.body.total).toBe("number")
    expect(list.body.data.some((t) => t.id === teamId)).toBe(true)

    // Delete (no members → allowed), then confirm it's gone.
    const deleted = await apiDelete<DeleteResult>(`/api/v1/teams/${teamId}`)
    expect(deleted.status).toBe(200)
    expect(deleted.body.ok).toBe(true)

    const afterDelete = await apiGet(`/api/v1/teams/${teamId}`)
    expect(afterDelete.status).toBe(404)
    teamId = null
  })
})
