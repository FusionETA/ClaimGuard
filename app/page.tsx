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
            <Image
              src="/logo.svg"
              alt="ClaimGuard logo"
              width={340}
              height={176}
              className="h-auto w-[250px] sm:w-[320px]"
              priority
            />
          </div>
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
