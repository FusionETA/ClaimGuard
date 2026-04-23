import { redirect } from "next/navigation"

import { updateHierarchyAction } from "@/app/(admin)/admin/hierarchy/actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getOrganizationHierarchy } from "@/modules/claims/application/services/admin-portal.service"

export default async function AdminHierarchyPage() {
  const members = await getOrganizationHierarchy()
  if (!members) redirect("/login")

  const supervisors = members.filter((member) => member.role === "SUPERVISOR")

  return (
    <div className="space-y-4">
      {members.map((member) => (
        <Card key={member.id}>
          <CardHeader className="p-5 pb-3 sm:p-6 sm:pb-4">
            <CardTitle className="text-lg">{member.name}</CardTitle>
            <CardDescription>
              {member.email} · {member.employeeId}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-5 pt-0 sm:p-6 sm:pt-0">
            <form action={updateHierarchyAction} className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_1fr_auto] md:items-end">
              <input type="hidden" name="userId" value={member.id} />
              <input type="hidden" name="email" value={member.email} />

              <label className="space-y-2 text-sm font-semibold text-muted-foreground">
                Role
                <select
                  name="role"
                  defaultValue={member.role}
                  className="h-11 w-full rounded-xl border border-transparent bg-surface-low px-3 text-base text-foreground shadow-sm sm:text-sm"
                >
                  <option value="EMPLOYEE">Basic Employee</option>
                  <option value="SUPERVISOR">Supervisor Employee</option>
                </select>
              </label>

              <label className="space-y-2 text-sm font-semibold text-muted-foreground">
                Project
                <input
                  name="project"
                  defaultValue={member.project}
                  className="h-11 w-full rounded-xl border border-transparent bg-surface-low px-3 text-base text-foreground shadow-sm sm:text-sm"
                />
              </label>

              <label className="space-y-2 text-sm font-semibold text-muted-foreground">
                Job title
                <input
                  name="jobTitle"
                  defaultValue={member.jobTitle}
                  className="h-11 w-full rounded-xl border border-transparent bg-surface-low px-3 text-base text-foreground shadow-sm sm:text-sm"
                />
              </label>

              <label className="space-y-2 text-sm font-semibold text-muted-foreground">
                Supervisor
                <select
                  name="supervisorId"
                  defaultValue={member.supervisorId ?? ""}
                  className="h-11 w-full rounded-xl border border-transparent bg-surface-low px-3 text-base text-foreground shadow-sm sm:text-sm"
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

              <Button type="submit" className="h-11 rounded-xl">
                Save
              </Button>
            </form>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
