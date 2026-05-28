import Image from "next/image"

import { LoginForm } from "@/app/login/login-form"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const loginCopy = {
  // eyebrow: "AltomateHR Access",
  title: "Login",
} as const

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const copy = loginCopy
  const sp = await searchParams
  // `?passwordReset=1` is set by the reset flow's final redirect so the
  // user gets confirmation that the password change went through.
  const passwordResetBanner = sp.passwordReset === "1"

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
                priority
              />
            </div>

            <div className="text-center">
              {/* <p className="text-s font-semibold tracking-[0.18em] text-primary">
                {copy.eyebrow}
              </p> */}
              <CardTitle className="mt-2 text-[2rem] leading-none sm:text-[2.4rem]">
                {copy.title}
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="p-5 pt-2 sm:p-8 sm:pt-6">
            {passwordResetBanner ? (
              <p className="mb-4 rounded-2xl border border-emerald-200/60 bg-emerald-50/70 px-4 py-3 text-sm font-medium text-emerald-800 dark:border-emerald-700/40 dark:bg-emerald-950/30 dark:text-emerald-200">
                Password updated. Sign in with your new password.
              </p>
            ) : null}
            <LoginForm />
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
