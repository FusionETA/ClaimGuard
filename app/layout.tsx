import type { Metadata, Viewport } from "next"
import { Manrope } from "next/font/google"

import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register"
import { ThemeProvider } from "@/components/theme-provider"
import { ToasterProvider } from "@/components/ui/toaster"
import { cn } from "@/lib/utils"

import "./globals.css"

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-headline",
  display: "swap",
})

const manropeBody = Manrope({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
})

export const metadata: Metadata = {
  title: {
    default: "ClaimGuard",
    template: "%s | ClaimGuard",
  },
  description:
    "ClaimGuard is a dual-portal expense claims platform for employees and administrators, built with Next.js, shadcn/ui, and Prisma.",
  applicationName: "ClaimGuard",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "ClaimGuard",
  },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icon.svg", type: "image/svg+xml" }],
  },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0D5E6B",
  colorScheme: "light dark",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={cn(manropeBody.variable, manrope.variable, "font-body")}>
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
        >
          <ToasterProvider>
            <ServiceWorkerRegister />
            {children}
          </ToasterProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
