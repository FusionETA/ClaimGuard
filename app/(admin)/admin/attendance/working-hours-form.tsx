"use client"

import { useActionState } from "react"
import { useFormStatus } from "react-dom"
import { Clock } from "lucide-react"

import { Button } from "@/components/attendance/ui/button"
import { Card } from "@/components/attendance/ui/card"
import { Input } from "@/components/attendance/ui/input"
import { Label } from "@/components/attendance/ui/label"

import { setWorkingHoursAction, type SetWorkingHoursState } from "./actions"

type Props = {
  initial: { start: string; end: string }
}

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? "Saving…" : "Save"}
    </Button>
  )
}

export function WorkingHoursForm({ initial }: Props) {
  const [state, formAction] = useActionState<SetWorkingHoursState, FormData>(
    setWorkingHoursAction,
    {},
  )

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2">
        <Clock className="h-5 w-5 text-primary" />
        <p className="text-sm font-bold text-foreground">Working hours</p>
      </div>
      <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Label htmlFor="start" className="text-[11px] uppercase tracking-wider">
            Start
          </Label>
          <Input
            id="start"
            name="start"
            type="time"
            defaultValue={initial.start}
            required
            className="mt-1"
          />
        </div>
        <div className="flex-1">
          <Label htmlFor="end" className="text-[11px] uppercase tracking-wider">
            End
          </Label>
          <Input
            id="end"
            name="end"
            type="time"
            defaultValue={initial.end}
            required
            className="mt-1"
          />
        </div>
        <SubmitButton />
      </form>
      {state.error ? (
        <p className="mt-2 text-xs font-semibold text-destructive">{state.error}</p>
      ) : null}
      {state.ok ? (
        <p className="mt-2 text-xs font-semibold text-success">Saved.</p>
      ) : null}
    </Card>
  )
}
