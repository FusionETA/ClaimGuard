import { afterAll, expect, it } from "vitest"

import {
  apiDelete,
  apiGet,
  apiPost,
  describeSmoke,
  isSmokeName,
  tag,
} from "./helpers/client"

/**
 * Smoke coverage for the projects API (manual/partner-created projects).
 *
 * Contract (from app/api/v1/projects/route.ts + [id]/route.ts):
 *  - GET    /api/v1/projects        -> 200 { data: Project[], total }
 *  - POST   /api/v1/projects        -> 201 { data: Project } (always isManual)
 *  - GET    /api/v1/projects/[id]   -> 200 { data: Project } | 404
 *  - DELETE /api/v1/projects/[id]   -> 200 { ok: true } | 404
 *
 * Only `name` is required on create; managers + geofence are optional and
 * omitted here to keep the fixture self-contained (no need for an existing
 * SUPERVISOR/ADMIN to assign as PM).
 */

type ExternalProject = {
  id: string
  name: string
  status: string | null
  isManual: boolean
  location: string | null
  latitude: number | null
  longitude: number | null
  workingHoursStart: string | null
  workingHoursEnd: string | null
  workingDays: unknown
  projectManagers: unknown
  holidays: unknown[]
}

describeSmoke("projects API smoke", () => {
  let projectId: string | null = null

  afterAll(async () => {
    if (projectId) {
      await apiDelete(`/api/v1/projects/${projectId}`)
    }
  })

  it("lists projects with the list envelope", async () => {
    const res = await apiGet<{ data: ExternalProject[]; total: number }>(
      "/api/v1/projects",
    )
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(typeof res.body.total).toBe("number")
  })

  it("creates, reads, and deletes a manual project", async () => {
    const name = tag("Project")

    // --- POST create (only the required `name`) ---
    const created = await apiPost<{ data: ExternalProject }>(
      "/api/v1/projects",
      { name },
    )
    expect(created.status).toBe(201)
    expect(created.body.data).toBeTruthy()
    expect(created.body.data.id).toBeTruthy()
    expect(created.body.data.name).toBe(name)
    expect(isSmokeName(created.body.data.name)).toBe(true)
    // POST always creates a manual project.
    expect(created.body.data.isManual).toBe(true)

    projectId = created.body.data.id

    // --- GET [id] and assert the single-resource shape ---
    const fetched = await apiGet<{ data: ExternalProject }>(
      `/api/v1/projects/${projectId}`,
    )
    expect(fetched.status).toBe(200)
    expect(fetched.body.data.id).toBe(projectId)
    expect(fetched.body.data.name).toBe(name)
    expect(fetched.body.data.isManual).toBe(true)
    expect(Array.isArray(fetched.body.data.holidays)).toBe(true)

    // --- DELETE and assert { ok: true } ---
    const deleted = await apiDelete<{ ok: boolean }>(
      `/api/v1/projects/${projectId}`,
    )
    expect(deleted.status).toBe(200)
    expect(deleted.body.ok).toBe(true)

    // --- GET [id] now 404s ---
    const gone = await apiGet<{ error: { status: number; message: string } }>(
      `/api/v1/projects/${projectId}`,
    )
    expect(gone.status).toBe(404)
    expect(gone.body.error.status).toBe(404)

    // Cleanup already done; clear so afterAll doesn't double-delete.
    projectId = null
  })
})
