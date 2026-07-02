"use client"

import { ArrowLeftRight, LoaderCircle } from "lucide-react"
import { useTransition } from "react"

import { switchCompanyAction } from "@/app/pick-company/actions"
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
 *
 * Icon + inline label chosen deliberately: the previous Building2
 * icon-only version was mistaken for "org info". `ArrowLeftRight`
 * reads as "swap" and pairs with the "Switch" label (hidden on
 * mobile to keep the header pill compact) so the affordance is
 * obvious at a glance.
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
      className="shrink-0 rounded-full"
      aria-label="Switch company"
    >
      {isPending ? (
        <LoaderCircle className="h-4 w-4 animate-spin" />
      ) : (
        <ArrowLeftRight className="h-4 w-4" />
      )}
      <span className="hidden sm:inline">Switch</span>
    </Button>
  )
}
