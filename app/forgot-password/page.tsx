import Image from "next/image"

import { ForgotPasswordForm } from "@/app/forgot-password/forgot-password-form"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

/**
 * /forgot-password
 *
 * Step 1 of 2 in the employee-only password reset flow.
 *
 * Posts to `requestPasswordResetAction`, which (silently for security)
 * sends a 6-digit code to the email when the address belongs to an
 * employee or supervisor. Admins / owners use a different recovery
 * channel and the action no-ops for them.
 *
 * On success the action redirects to /forgot-password/verify with the
 * email in the query string so step 2 can pre-fill it.
 */
export default function ForgotPasswordPage() {
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
              <CardTitle>Reset your password</CardTitle>
              <CardDescription className="mt-2">
                Enter your work email and we&apos;ll send you a 6-digit reset code.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="p-5 pt-6 sm:p-8 sm:pt-6">
            <ForgotPasswordForm />
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
