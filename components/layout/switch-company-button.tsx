"use client"

import { Building2, LoaderCircle } from "lucide-react"
import { useTransition } from "react"

import { switchCompanyAction } from "@/app/(employee)/employee/pick-company/actions"
import { Button } from "@/components/ui/button"

/**
 * "Switch Company" trigger for multi-org employees. Sits next to
 * `<ChangePasswordButton />` and `<LogoutButton />` in the employee
 * shell header. Fires a server action that clears
 * `session.activeOrganizationId` and redirects to the picker.
 *
 * Only rendered when the employee has 2+ active EmployeeOrganization
 * memberships — single-org employees don't need this button and
 * wouldn't have a meaningful destination on the picker either.
 */
export function SwitchCompanyButton() {
  const [isPending, startTransition] = useTransition()

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() =>
        startTransition(() => {
          void switchCompanyAction()
        })
      }
      disabled={isPending}
      title="Switch company"
      className="h-9 w-9 shrink-0 rounded-full p-0"
      aria-label="Switch company"
    >
      {isPending ? (
        <LoaderCircle className="h-4 w-4 animate-spin" />
      ) : (
        <Building2 className="h-4 w-4" />
      )}
    </Button>
  )
}
