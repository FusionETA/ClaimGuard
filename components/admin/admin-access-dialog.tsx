"use client"

import * as React from "react"
import { useActionState } from "react"
import { Loader2, ShieldCheck } from "lucide-react"

import { saveAdminAccessAction } from "@/app/(admin)/admin/settings/actions"
import {
  initialSettingsActionState,
} from "@/app/(admin)/admin/settings/form-state"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { useToastOnAction } from "@/components/ui/toaster"
import {
  ADMIN_MODULES,
  AdminAccessPicker,
  type AdminAccess,
  type AdminModuleKey,
} from "@/components/admin/admin-access-picker"

/**
 * "Edit access" dialog opened from the admin row. Two pickers — modules
 * + policies — each with their own Select-all toggle. The dialog wraps
 * `saveAdminAccessAction` server-side so changes persist to the
 * `AdminOrganization` row for this admin in the active org.
 *
 * The parent supplies `initialAccess` so the dialog seeds the pickers
 * from the persisted scope (or full access for legacy rows). After save,
 * the action revalidates the settings page so the parent re-renders
 * with the freshly-saved values.
 */
export function AdminAccessDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  adminId: string
  adminName: string
  initialAccess: AdminAccess
  policyOptions: ReadonlyArray<{ value: string; label: string }>
}) {
  const [state, action, pending] = useActionState(
    saveAdminAccessAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  const [modules, setModules] = React.useState<AdminModuleKey[]>(
    props.initialAccess.modules,
  )
  const [policyIds, setPolicyIds] = React.useState<string[]>(
    props.initialAccess.policyIds,
  )

  // Reset back to the persisted values whenever the dialog re-opens for
  // a different admin (or the parent updates the source values mid-edit).
  React.useEffect(() => {
    if (props.open) {
      setModules(props.initialAccess.modules)
      setPolicyIds(props.initialAccess.policyIds)
    }
  }, [props.open, props.initialAccess.modules, props.initialAccess.policyIds])

  // Close the dialog automatically on a successful save. The toast hook
  // surfaces the message; the parent re-fetches admins via revalidate.
  React.useEffect(() => {
    if (state.status === "success") {
      props.onOpenChange(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form action={action}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              Manage access — {props.adminName}
            </DialogTitle>
            <DialogDescription>
              Choose which modules and policies this admin can see. Untick
              anything they shouldn&apos;t touch. Both fields default to
              everything granted; tick &ldquo;Select all&rdquo; to flip the
              whole list at once.
            </DialogDescription>
          </DialogHeader>

          {/* Hidden inputs are what the server action reads. The pickers
              are just visual state; we mirror their values to these
              CSVs so the form submission shape matches the invite-form
              path (same `parseCsvAccess` helper). */}
          <input type="hidden" name="adminId" value={props.adminId} />
          <input
            type="hidden"
            name="accessModules"
            value={modules.join(",")}
          />
          <input
            type="hidden"
            name="accessPolicyIds"
            value={policyIds.join(",")}
          />

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Modules</Label>
              <AdminAccessPicker
                label="Modules"
                options={ADMIN_MODULES}
                value={modules}
                onChange={(v) => setModules(v as AdminModuleKey[])}
                disabled={pending}
              />
              <p className="text-[11px] text-muted-foreground">
                Top-level admin sections in the sidebar.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Policies</Label>
              <AdminAccessPicker
                label="Policies"
                options={props.policyOptions}
                value={policyIds}
                onChange={setPolicyIds}
                disabled={pending}
              />
              <p className="text-[11px] text-muted-foreground">
                Limit which employee groups this admin can manage (Claims,
                Leave, Attendance, Payroll preview all filter by the
                picked policies). Leave all ticked for full org access.
              </p>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:flex-row sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              onClick={() => props.onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save access"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
