import Link from "next/link"
import Image from "next/image"
import { ArrowRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export default function HomePage() {
  return (
    <main className="container flex h-[100svh] flex-col items-center justify-center overflow-hidden py-4 sm:min-h-screen sm:py-10">
      <div className="max-w-md space-y-4">
        <div className="mb-6 text-center sm:mb-8">
          <div className="flex justify-center">
            <div className="rounded-[24px] border border-white/60 bg-white/80 p-2.5 shadow-ambient sm:rounded-[28px] sm:p-3">
              <Image
                src="/icon.svg"
                alt="ClaimGuard logo"
                width={72}
                height={72}
                className="h-14 w-14 rounded-2xl sm:h-[72px] sm:w-[72px] sm:rounded-[20px]"
                priority
              />
            </div>
          </div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            ClaimGuard
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Company Login</CardTitle>
            <CardDescription>
              Use your assigned account to continue.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full justify-between">
              <Link href="/login">
                Login
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
