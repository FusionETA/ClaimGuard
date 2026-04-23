import Link from "next/link"
import Image from "next/image"
import { ArrowLeft, ShieldCheck } from "lucide-react"
import { redirect } from "next/navigation"

import { LoginForm } from "@/app/login/login-form"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getCurrentSession, getHomePathForRole } from "@/lib/auth/session"

const loginCopy = {
  eyebrow: "ClaimGuard Access",
  title: "Login once, continue to the right workspace",
  mobileTitle: "Welcome back",
  mobileDescription: "Sign in and we will route you to the right workspace automatically.",
} as const

export default async function LoginPage() {
  const session = await getCurrentSession()

  if (session) {
    redirect(getHomePathForRole(session.role))
  }

  const copy = loginCopy

  return (
    <main className="flex h-[100svh] items-center overflow-hidden px-4 py-4 sm:min-h-screen sm:px-6 sm:py-10 lg:px-8">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-center">
        <div className="grid w-full gap-4 sm:gap-6 lg:grid-cols-[1.05fr_0.95fr]">
          <Card className="hidden overflow-hidden border-white/50 bg-gradient-to-br from-primary to-[#2a5084] text-primary-foreground lg:block">
            <CardContent className="flex h-full flex-col justify-between p-8">
              <div>
                <Link
                  href="/"
                  className="inline-flex items-center gap-2 text-sm font-semibold text-primary-foreground/80 transition hover:text-primary-foreground"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Back to home
                </Link>

                <div className="mt-10 flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/15">
                    <ShieldCheck className="h-6 w-6" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary-foreground/70">
                      ClaimGuard
                    </p>
                    <p className="font-headline text-2xl font-black">Secure access</p>
                  </div>
                </div>

                <p className="mt-10 text-xs font-semibold uppercase tracking-[0.18em] text-primary-foreground/70">
                  {copy.eyebrow}
                </p>
                <h1 className="mt-3 max-w-lg font-headline text-4xl font-black tracking-tight">
                  {copy.title}
                </h1>
              </div>

            </CardContent>
          </Card>

          <div className="space-y-3 sm:space-y-4">
            <div className="lg:hidden">
              <div className="mx-auto flex w-fit items-center gap-3 rounded-full border border-white/60 bg-white/85 px-4 py-2.5 shadow-ambient">
                <Image
                  src="/icon.svg"
                  alt="ClaimGuard logo"
                  width={44}
                  height={44}
                  className="h-10 w-10 rounded-2xl"
                  priority
                />
                <div className="text-left">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
                    {copy.eyebrow}
                  </p>
                  <p className="font-headline text-lg font-black tracking-tight text-foreground">
                    ClaimGuard
                  </p>
                </div>
              </div>
            </div>

            <Card className="border-white/60">
              <CardHeader className="p-5 pb-3 sm:p-8 sm:pb-0">
                <div className="text-center lg:hidden">
                  <CardTitle className="text-[2rem] leading-none sm:text-[2.4rem]">
                    {copy.mobileTitle}
                  </CardTitle>
                  <CardDescription className="mt-2 text-sm leading-6 sm:mt-3 sm:text-base sm:leading-7">
                    {copy.mobileDescription}
                  </CardDescription>
                </div>

                <div className="hidden lg:block">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                    {copy.eyebrow}
                  </p>
                  <CardTitle className="text-3xl">Login</CardTitle>
                  <CardDescription>
                    Enter your account email and password to continue.
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent className="p-5 pt-2 sm:p-8 sm:pt-6">
                <LoginForm />
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </main>
  )
}
