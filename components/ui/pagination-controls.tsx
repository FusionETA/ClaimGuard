"use client"

import { Button } from "@/components/ui/button"

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
    </div>
  )
}
