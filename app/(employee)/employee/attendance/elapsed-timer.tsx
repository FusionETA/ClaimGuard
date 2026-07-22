"use client"

import { useEffect, useState } from "react"

function fmt(startedAt: string): string {
  const totalMin = Math.floor((Date.now() - new Date(startedAt).getTime()) / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export function ElapsedTimer({ startedAt }: { startedAt: string }) {
  const [display, setDisplay] = useState(() => fmt(startedAt))

  useEffect(() => {
    const id = setInterval(() => setDisplay(fmt(startedAt)), 60_000)
    return () => clearInterval(id)
  }, [startedAt])

  return <span className="text-amber-500">{display} (running)</span>
}
