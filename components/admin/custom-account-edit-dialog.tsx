"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"

import {
  deleteCustomAccountAction,
  updateCustomAccountAction,
} from "@/app/(admin)/admin/settings/actions"
import { Button } from "@/components/ui/button"
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useToast } from "@/components/ui/toaster"

// Common Xero AccountType values, in the order admins reach for them most.
// `BANK` is the magic string the bank-detection logic keys on (see
// modules/organization/CLAUDE.md). The picker also exposes a "Custom…"
// option that reveals a free-text input for COAs using non-Xero labels.
const KNOWN_TYPES = [
  "EXPENSE",
  "BANK",
  "REVENUE",
  "DIRECTCOSTS",
  "OVERHEADS",
  "CURRENT",
  "CURRLIAB",
  "FIXED",
  "EQUITY",
  "OTHERINCOME",
  "DEPRECIATN",
  "PREPAYMENT",
] as const

const CUSTOM_SENTINEL = "__custom__"

export function CustomAccountTypeSelect({
  value,
  onValueChange,
  placeholder = "Type (optional)",
  triggerClassName,
}: {
  value: string
  onValueChange: (next: string) => void
  placeholder?: string
  triggerClassName?: string
}) {
  // `value` is the canonical stored type ("" / "BANK" / "MY-CUSTOM").
  // When it matches a known type → Select shows that option.
  // Otherwise (non-empty + not in list) → custom mode is active and the
  // Input below carries the value.
  const isKnown = (KNOWN_TYPES as readonly string[]).includes(value)
  const [customMode, setCustomMode] = useState<boolean>(
    Boolean(value) && !isKnown,
  )
  // Keep customMode aligned when `value` changes from outside (e.g. when
  // the dialog opens with a saved row's existing type).
  useEffect(() => {
    if (value && !(KNOWN_TYPES as readonly string[]).includes(value)) {
      setCustomMode(true)
    }
  }, [value])

  const selectValue = customMode ? CUSTOM_SENTINEL : value || ""

  return (
    <div className="flex flex-col gap-2">
      <Select
        value={selectValue}
        onValueChange={(v) => {
          if (v === CUSTOM_SENTINEL) {
            setCustomMode(true)
            onValueChange("")
            return
          }
          setCustomMode(false)
          onValueChange(v)
        }}
      >
        <SelectTrigger className={triggerClassName ?? "w-44"}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {KNOWN_TYPES.map((t) => (
            <SelectItem key={t} value={t}>
              {t}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_SENTINEL}>Custom…</SelectItem>
        </SelectContent>
      </Select>
      {customMode && (
        <Input
          autoFocus
          placeholder="Custom type"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          className={triggerClassName ?? "w-44"}
        />
      )}
    </div>
  )
}

export function CustomAccountEditDialog({
  open,
  onOpenChange,
  account,
  onSaved,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  account: {
    id: string
    code: string
    name: string
    type: string | null
    isSelectable: boolean
  }
  /// Called after a successful save or delete so the parent can
  /// `router.refresh()` if it doesn't already revalidate via the
  /// server action's `revalidatePath`.
  onSaved?: () => void
}) {
  const { toast } = useToast()
  const [code, setCode] = useState(account.code)
  const [name, setName] = useState(account.name)
  const [type, setType] = useState(account.type ?? "")
  const [isSelectable, setIsSelectable] = useState(account.isSelectable)
  const [pending, setPending] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Reset local state whenever the dialog opens with a (possibly
  // different) account — without this, switching rows would carry the
  // previous edits over.
  useEffect(() => {
    if (open) {
      setCode(account.code)
      setName(account.name)
      setType(account.type ?? "")
      setIsSelectable(account.isSelectable)
    }
  }, [open, account])

  async function handleSave() {
    setPending(true)
    const result = await updateCustomAccountAction({
      id: account.id,
      code,
      name,
      type: type || undefined,
      isSelectable,
    })
    setPending(false)
    if (result.ok) {
      toast({ title: result.message, variant: "success" })
      onOpenChange(false)
      onSaved?.()
    } else {
      toast({ title: result.message, variant: "error" })
    }
  }

  async function handleDelete() {
    setDeleting(true)
    const result = await deleteCustomAccountAction(account.id)
    setDeleting(false)
    if (result.ok) {
      toast({ title: result.message, variant: "success" })
      onOpenChange(false)
      onSaved?.()
    } else {
      toast({ title: result.message, variant: "error" })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit custom account</DialogTitle>
          <DialogDescription>
            Update the code, name, type, or selectability for this custom
            chart-of-account. Deleting removes the account from this org.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1.5 text-sm font-semibold text-muted-foreground">
            <span>Code</span>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={pending || deleting}
              required
            />
          </label>
          <label className="block space-y-1.5 text-sm font-semibold text-muted-foreground">
            <span>Account name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={pending || deleting}
              required
            />
          </label>
          <label className="block space-y-1.5 text-sm font-semibold text-muted-foreground">
            <span>Type</span>
            <CustomAccountTypeSelect
              value={type}
              onValueChange={setType}
              triggerClassName="w-full"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={isSelectable}
              onChange={(e) => setIsSelectable(e.target.checked)}
              disabled={pending || deleting}
              className="h-4 w-4 rounded border-border text-primary"
            />
            Selectable (employees can pick this account on a claim)
          </label>
        </div>
        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          <ConfirmActionDialog
            title="Delete this custom account?"
            description={`This will permanently remove ${account.code} · ${account.name} from this organisation. Claims already using it stay intact.`}
            confirmLabel="Delete account"
            confirmVariant="destructive"
            triggerLabel="Delete"
            pendingLabel="Deleting…"
            triggerVariant="ghost"
            triggerClassName="text-destructive hover:text-destructive"
            pending={deleting}
            disabled={pending}
            onConfirm={handleDelete}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={pending || deleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSave}
              disabled={pending || deleting || !code.trim() || !name.trim()}
            >
              {pending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save changes"
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

