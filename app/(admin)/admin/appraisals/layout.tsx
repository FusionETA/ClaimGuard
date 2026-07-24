import "@/app/(employee)/employee/appraisals/appraisify.css"

/**
 * Nested layout for the admin Appraisify surface. Composes inside the admin
 * shell and applies the same scoped design tokens + Material Symbols font as
 * the employee side (reusing the shared appraisify.css).
 */
export default function AdminAppraisalsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="appraisify-scope">
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=block"
      />
      {children}
    </div>
  )
}
