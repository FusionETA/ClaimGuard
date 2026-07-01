"use client"

import { useTransition } from "react"
import { Building2, Loader2 } from "lucide-react"

import type { EmployeeOrganizationMembership } from "@/modules/organization/infrastructure/employee-organization.repository"
import { cn } from "@/lib/utils"
import { selectCompanyAction } from "./actions"

/**
 * Card grid of company choices. One card per active EmployeeOrganization
 * membership. Clicking a card fires the server action; a pending
 * transition dims the whole grid + shows a spinner on the picked card
 * so double-taps don't fire the mutation twice.
 */
export function PickCompanyGrid({
  memberships,
}: {
  memberships: EmployeeOrganizationMembership[]
}) {
  const [isPending, startTransition] = useTransition()

  function handlePick(orgId: string) {
    startTransition(() => {
      const formData = new FormData()
      formData.append("organizationId", orgId)
      void selectCompanyAction(formData)
    })
  }

  return (
    <div
      className={cn(
        "grid gap-3 sm:grid-cols-2",
        isPending && "pointer-events-none opacity-70",
      )}
    >
      {memberships.map((m) => (
        <button
          key={m.organizationId}
          type="button"
          onClick={() => handlePick(m.organizationId)}
          className={cn(
            "group relative flex items-start gap-3 rounded-xl border border-border/60 bg-card p-4 text-left transition-all",
            "hover:border-primary hover:bg-primary/5 hover:shadow-panel",
            "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
          )}
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary group-hover:bg-primary group-hover:text-primary-foreground">
            {isPending ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Building2 className="h-5 w-5" />
            )}
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="font-semibold">{m.organizationName}</span>
            <span className="text-xs text-muted-foreground">
              Continue as employee
            </span>
          </div>
        </button>
      ))}
    </div>
  )
}
