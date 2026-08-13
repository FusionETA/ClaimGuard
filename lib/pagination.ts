export type PageItem = number | "ellipsis"

function range(start: number, end: number): number[] {
  const out: number[] = []
  for (let i = start; i <= end; i += 1) out.push(i)
  return out
}

/**
 * Build the list of tokens to render for a numbered paginator: always the
 * first and last page, a window of `siblings` pages either side of the
 * current page, and an "ellipsis" marker wherever a gap is collapsed.
 * Mirrors the well-known MUI `usePagination` behaviour so the control
 * stays a fixed, predictable width no matter how many pages there are.
 *
 * Examples (siblings = 1):
 *   current 1  / 8 pages → [1, 2, 3, 4, 5, …, 8]
 *   current 4  / 8 pages → [1, …, 3, 4, 5, …, 8]
 *   current 8  / 8 pages → [1, …, 4, 5, 6, 7, 8]
 *   current 5  / 5 pages → [1, 2, 3, 4, 5]        (no ellipsis needed)
 */
export function buildPageItems(
  currentPage: number,
  totalPages: number,
  siblings = 1,
): PageItem[] {
  // first + last + current + siblings on each side + two ellipsis slots
  const maxSlots = siblings * 2 + 5
  if (totalPages <= maxSlots) {
    return range(1, Math.max(totalPages, 1))
  }

  const leftSibling = Math.max(currentPage - siblings, 1)
  const rightSibling = Math.min(currentPage + siblings, totalPages)

  const showLeftEllipsis = leftSibling > 2
  const showRightEllipsis = rightSibling < totalPages - 1

  if (!showLeftEllipsis && showRightEllipsis) {
    return [...range(1, 3 + siblings * 2), "ellipsis", totalPages]
  }
  if (showLeftEllipsis && !showRightEllipsis) {
    return [1, "ellipsis", ...range(totalPages - (2 + siblings * 2), totalPages)]
  }
  return [1, "ellipsis", ...range(leftSibling, rightSibling), "ellipsis", totalPages]
}
