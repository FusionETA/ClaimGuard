"use client"

import * as React from "react"

import { Button, type ButtonProps } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

type ConfirmActionDialogProps = {
  title: string
  description: string
  confirmLabel: string
  cancelLabel?: string
  pending?: boolean
  triggerLabel: string
  pendingLabel?: string
  triggerVariant?: ButtonProps["variant"]
  triggerSize?: ButtonProps["size"]
  triggerClassName?: string
  confirmVariant?: ButtonProps["variant"]
  confirmClassName?: string
  onConfirm?: () => void
}

export function ConfirmActionDialog({
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  pending = false,
  triggerLabel,
  pendingLabel,
  triggerVariant = "default",
  triggerSize = "default",
  triggerClassName,
  confirmVariant = "default",
  confirmClassName,
  onConfirm,
}: ConfirmActionDialogProps) {
  const [open, setOpen] = React.useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant={triggerVariant}
          size={triggerSize}
          className={triggerClassName}
          disabled={pending}
        >
          {pending ? pendingLabel ?? triggerLabel : triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost" disabled={pending}>
              {cancelLabel}
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant={confirmVariant}
            className={confirmClassName}
            disabled={pending}
            onClick={() => {
              onConfirm?.()
              setOpen(false)
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type ConfirmSubmitButtonProps = Omit<
  ConfirmActionDialogProps,
  "onConfirm"
> & {
  formId: string
}

export function ConfirmSubmitButton({
  formId,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  pending = false,
  triggerLabel,
  pendingLabel,
  triggerVariant = "default",
  triggerSize = "default",
  triggerClassName,
  confirmVariant = "default",
  confirmClassName,
}: ConfirmSubmitButtonProps) {
  const [open, setOpen] = React.useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant={triggerVariant}
          size={triggerSize}
          className={triggerClassName}
          disabled={pending}
        >
          {pending ? pendingLabel ?? triggerLabel : triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost" disabled={pending}>
              {cancelLabel}
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant={confirmVariant}
            className={confirmClassName}
            disabled={pending}
            onClick={() => {
              const form = document.getElementById(formId)
              if (form instanceof HTMLFormElement) {
                form.requestSubmit()
              }
              setOpen(false)
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
