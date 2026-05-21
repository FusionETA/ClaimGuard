import Link from "next/link"

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
      <h2 className="text-2xl font-semibold">Page not found</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        The page you were looking for doesn&apos;t exist or has moved.
      </p>
      <Link
        href="/"
        className="mt-2 rounded-md border px-4 py-2 text-sm hover:bg-muted"
      >
        Go home
      </Link>
    </div>
  )
}
