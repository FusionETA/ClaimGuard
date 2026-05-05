"use client"

import { useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const ALL = "ALL"

type Props = {
  projects: Array<{ id: string; name: string }>
  value: string | null
  paramName?: string
}

export function ProjectFilterPicker({
  projects,
  value,
  paramName = "projectId",
}: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  function handleChange(next: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (next === ALL) {
      params.delete(paramName)
    } else {
      params.set(paramName, next)
    }
    const qs = params.toString()
    const href = (qs ? `${pathname}?${qs}` : pathname) as never
    startTransition(() => {
      router.push(href)
    })
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Project
      </span>
      <div className="w-[220px]">
        <Select
          value={value ?? ALL}
          onValueChange={handleChange}
          disabled={pending}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All projects</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
