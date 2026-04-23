import { formatMonthLabel } from "@/lib/utils"

export function VolumeChart({
  points,
}: {
  points: { month: string; total: number }[]
}) {
  const maxValue = Math.max(...points.map((point) => point.total), 1)

  return (
    <div className="flex h-56 items-end gap-3">
      {points.map((point) => {
        const height = Math.max((point.total / maxValue) * 100, 16)

        return (
          <div key={point.month} className="flex flex-1 flex-col items-center gap-3">
            <div className="flex h-full w-full items-end rounded-t-3xl bg-surface-low p-1">
              <div
                className="w-full rounded-[1rem] bg-gradient-to-b from-primary to-[#2a5084]"
                style={{ height: `${height}%` }}
              />
            </div>
            <div className="text-center">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
                {formatMonthLabel(point.month)}
              </p>
              <p className="text-xs text-muted-foreground">{point.total} claims</p>
            </div>
          </div>
        )
      })}
    </div>
  )
}

