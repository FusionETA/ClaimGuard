"use client"

import { ChevronLeft, ChevronRight } from "lucide-react"
import { usePathname } from "next/navigation"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { buildPageItems } from "@/lib/pagination"

type PaginationControlsProps = {
  className?: string
  currentPage: number
  pageSize: number
  totalItems: number
  itemLabel?: string
  onPageChange: (page: number) => void
}

export function PaginationControls({
  className,
  currentPage,
  pageSize,
  totalItems,
  itemLabel = "items",
  onPageChange,
}: PaginationControlsProps) {
  // Numbered page buttons (1 · 2 · 3 … 8) are an admin-portal affordance —
  // admin tables run long, so jumping straight to a page beats clicking
  // Next repeatedly. Employee/supervisor surfaces keep the simple
  // Prev/Next pager. Gated by URL so shared tables (daily-activity,
  // hours-summary) pick the right control automatically.
  const pathname = usePathname()
  const isAdmin = pathname?.startsWith("/admin") ?? false

  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
  const startItem = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1
  const endItem = Math.min(currentPage * pageSize, totalItems)

  if (totalItems <= pageSize) {
    return null
  }

  return (
    <div className={className}>
      <div className="text-sm text-muted-foreground">
        Showing <span className="font-semibold text-foreground">{startItem}</span>-
        <span className="font-semibold text-foreground">{endItem}</span> of{" "}
        <span className="font-semibold text-foreground">{totalItems}</span> {itemLabel}
      </div>

      {isAdmin ? (
        <PageNumbers
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={onPageChange}
        />
      ) : (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-full"
            disabled={currentPage === 1}
            onClick={() => onPageChange(currentPage - 1)}
          >
            Previous
          </Button>
          <span className="text-sm font-medium text-foreground">
            Page {currentPage} of {totalPages}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-full"
            disabled={currentPage === totalPages}
            onClick={() => onPageChange(currentPage + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * Numbered pager: ‹ 1 2 3 … 8 › with the current page highlighted and
 * ellipses collapsing long runs. Reused by the shared control above and
 * the bespoke payroll paginators. Renders nothing for a single page.
 */
export function PageNumbers({
  currentPage,
  totalPages,
  onPageChange,
  className,
}: {
  currentPage: number
  totalPages: number
  onPageChange: (page: number) => void
  className?: string
}) {
  if (totalPages <= 1) return null

  const items = buildPageItems(currentPage, totalPages)

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-9 rounded-full px-0"
        aria-label="Previous page"
        disabled={currentPage === 1}
        onClick={() => onPageChange(currentPage - 1)}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>

      {items.map((item, idx) =>
        item === "ellipsis" ? (
          <span
            key={`ellipsis-${idx}`}
            aria-hidden
            className="w-6 select-none text-center text-sm text-muted-foreground sm:w-9"
          >
            …
          </span>
        ) : (
          <Button
            key={item}
            type="button"
            variant={item === currentPage ? "default" : "ghost"}
            size="sm"
            aria-label={`Page ${item}`}
            aria-current={item === currentPage ? "page" : undefined}
            className={cn(
              "min-w-9 rounded-full px-2 tabular-nums",
              item === currentPage && "pointer-events-none",
            )}
            onClick={() => onPageChange(item)}
          >
            {item}
          </Button>
        ),
      )}

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-9 rounded-full px-0"
        aria-label="Next page"
        disabled={currentPage === totalPages}
        onClick={() => onPageChange(currentPage + 1)}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  )
}
