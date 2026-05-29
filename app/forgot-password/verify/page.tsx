import Image from "next/image"
import { redirect } from "next/navigation"
import { z } from "zod"

import { VerifyForm } from "@/app/forgot-password/verify/verify-form"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

/**
 * /forgot-password/verify?email=<email>
 *
 * Step 2 of 2 in the password reset flow. Step 1 redirects here with
 * the email in the query string. Missing / malformed email → bounce
 * the user back to step 1 (otherwise the form would be missing the
 * hidden field that the action requires).
 */

const emailSchema = z.string().trim().min(1).email().toLowerCase()

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const raw = typeof sp.email === "string" ? sp.email : ""
  const parsed = emailSchema.safeParse(raw)
  if (!parsed.success) {
    redirect("/forgot-password")
  }
  const email = parsed.data

  return (
    <main className="flex min-h-[100svh] items-center px-4 py-4 sm:min-h-screen sm:px-6 sm:py-10 lg:px-8">
      <div className="mx-auto w-full max-w-xl">
        <Card className="border-white/60">
          <CardHeader className="space-y-6 p-5 pb-3 sm:p-8 sm:pb-0">
            <div className="mx-auto flex h-[140px] w-[140px] items-center justify-center rounded-[28px] border border-white/60 bg-white/85 p-4 shadow-ambient">
              <Image
                src="/brand-icon.png"
                alt="AltomateHR logo"
                width={512}
                height={512}
                className="h-auto w-[108px] object-contain"
              />
            </div>
            <div className="text-center">
              <CardTitle>Enter your reset code</CardTitle>
              <CardDescription className="mt-2">
                We sent a 6-digit code to your WhatsApp. It expires in 10 minutes.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="p-5 pt-6 sm:p-8 sm:pt-6">
            <VerifyForm email={email} />
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
