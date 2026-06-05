import type { Metadata } from "next"
import Image from "next/image"

/**
 * /maintenance — the page everyone lands on while `MAINTENANCE_MODE=true`
 * is set in the deployment env. Middleware rewrites every page request
 * here (and 503's every API request) until the env flag is flipped off.
 *
 * Lives at the root level of `app/` (not inside `(admin)` or
 * `(employee)`) so it inherits ONLY the root layout — no admin
 * sidebar, no employee shell, no auth gate. The maintenance page
 * must be reachable even when the rest of the app is being rebuilt.
 *
 * The optional `MAINTENANCE_MESSAGE` env lets ops drop in a one-line
 * message ("Back by 18:00 MYT" / "Database upgrade in progress") so
 * users see context without a code change. Falls back to a generic
 * line when unset.
 */

export const metadata: Metadata = {
  title: "Maintenance",
  description: "AltomateHR is undergoing scheduled maintenance.",
  robots: { index: false, follow: false },
}

export default function MaintenancePage() {
  const customMessage = process.env.MAINTENANCE_MESSAGE?.trim()

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-16">
      <div className="w-full max-w-md space-y-6 text-center">
        <div className="flex justify-center">
          <Image
            src="/brand-icon-white.png"
            alt="AltomateHR"
            width={72}
            height={72}
            className="rounded-2xl shadow-md"
            priority
          />
        </div>

        <div className="space-y-3">
          <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            We&rsquo;ll be right back
          </h1>
          <p className="text-base leading-7 text-muted-foreground">
            AltomateHR is currently undergoing scheduled maintenance.
            We&rsquo;re improving the system and will be back online
            shortly.
          </p>
          {customMessage ? (
            <p className="mt-4 inline-block rounded-full bg-primary/10 px-4 py-2 text-sm font-medium text-primary">
              {customMessage}
            </p>
          ) : null}
          <p className="pt-2 text-sm text-muted-foreground">
            Thank you for your patience.
          </p>
        </div>

        <div className="pt-4 text-xs text-muted-foreground">
          If you have an urgent issue, contact{" "}
          <a
            href="mailto:support@fusioneta.com"
            className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
          >
            support@fusioneta.com
          </a>
          .
        </div>
      </div>
    </main>
  )
}
