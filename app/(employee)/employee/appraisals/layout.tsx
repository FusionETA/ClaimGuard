import "./appraisify.css"

/**
 * Nested layout for the Appraisify module. Composes *inside* the employee
 * shell (nav + header from `app/(employee)/employee/layout.tsx`) and:
 *   - loads the Material Symbols Outlined icon font (Manrope is already global),
 *   - imports the scoped `appraisify.css` design tokens,
 *   - wraps the tree in `.appraisify-scope` so the reference blue (#136dec),
 *     flat background, shimmer skeletons and component classes apply here only.
 *
 * React 19 hoists the <link> into <head> automatically.
 */
export default function AppraisalsLayout({
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
