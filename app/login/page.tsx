import Image from "next/image"
import { redirect } from "next/navigation"

import { LoginForm } from "@/app/login/login-form"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getCurrentSession, getHomePathForRole } from "@/lib/auth/session"

const loginCopy = {
  eyebrow: "ClaimGuard Access",
  title: "Login",
} as const

export default async function LoginPage() {
  const session = await getCurrentSession()

  if (session) {
    redirect(getHomePathForRole(session.role))
  }

  const copy = loginCopy

  return (
    <main className="flex h-[100svh] items-center overflow-hidden px-4 py-4 sm:min-h-screen sm:px-6 sm:py-10 lg:px-8">
      <div className="mx-auto w-full max-w-xl">
        <Card className="border-white/60">
          <CardHeader className="space-y-6 p-5 pb-3 sm:p-8 sm:pb-0">
            <div className="mx-auto flex w-fit items-center rounded-[28px] border border-white/60 bg-white/85 px-5 py-4 shadow-ambient">
              <Image
                src="/brand-icon.png"
                alt="ClaimGuard logo"
                width={512}
                height={512}
                className="h-auto w-[108px] object-contain"
                priority
              />
            </div>

            <div className="text-center">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                {copy.eyebrow}
              </p>
              <CardTitle className="mt-2 text-[2rem] leading-none sm:text-[2.4rem]">
                {copy.title}
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="p-5 pt-2 sm:p-8 sm:pt-6">
            <LoginForm />
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
