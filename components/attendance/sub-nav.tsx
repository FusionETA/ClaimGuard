"use client"

import type { Route } from "next"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { cn } from "@/lib/utils"

type SubNavItem = {
  href: string
  label: string
  badge?: boolean
}

type Props = {
  items: ReadonlyArray<SubNavItem>
}

export function AttendanceSubNav({ items }: Props) {
  const pathname = usePathname()

  return (
    <nav className="lg:hidden -mx-6 mb-4 overflow-x-auto px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex gap-2">
        {items.map((item) => {
          const active = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href as Route}
              className={cn(
                "relative shrink-0 rounded-full border px-4 py-1.5 text-xs font-semibold transition-colors",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border/60 bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
              {item.badge ? (
                <span
                  aria-label="pending"
                  className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-destructive shadow-[0_0_0_2px_hsl(var(--card))]"
                />
              ) : null}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
