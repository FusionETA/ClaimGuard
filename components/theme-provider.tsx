"use client"

import * as React from "react"
import { ThemeProvider as NextThemesProvider } from "next-themes"

// React 19 warns about <script> tags inside component trees, even when
// suppressHydrationWarning is set. next-themes injects one for FOUC prevention
// (server-only, never re-runs on the client). Suppress just that warning.
if (typeof window !== "undefined") {
  const _err = console.error.bind(console)
  console.error = (...args: Parameters<typeof console.error>) => {
    if (typeof args[0] === "string" && args[0].includes("Encountered a script tag"))
      return
    _err(...args)
  }
}

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>
}
