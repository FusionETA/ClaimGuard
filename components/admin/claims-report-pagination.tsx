"use client"

import { useRouter, useSearchParams } from "next/navigation"

import { PaginationControls } from "@/components/ui/pagination-controls"

/**
 * Thin URL-aware adapter around the shared `PaginationControls`.
 * The reports page is server-rendered + URL-driven, so changing
 * pages is just a search-param update. Wrapped in a client component
 * because `PaginationControls` itself is "use client" and the
 * onPageChange callback needs the router.
 */
export function ClaimsReportPagination({
  currentPage,
  pageSize,
  totalItems,
}: {
  currentPage: number
  pageSize: number
  totalItems: number
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  return (
    <PaginationControls
      className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      currentPage={currentPage}
      pageSize={pageSize}
      totalItems={totalItems}
      itemLabel="claims"
      onPageChange={(page) => {
        const next = new URLSearchParams(searchParams.toString())
        if (page <= 1) next.delete("page")
        else next.set("page", String(page))
        const qs = next.toString()
        router.push(
          qs ? `/admin/claims/breakdown?${qs}` : "/admin/claims/breakdown",
        )
      }}
    />
  )
}
