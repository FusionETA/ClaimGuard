import type { Metadata, Viewport } from "next"
import { Manrope } from "next/font/google"

import { AppResumeIndicator } from "@/components/pwa/app-resume-indicator"
import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register"
import { ThemeProvider } from "@/components/theme-provider"
import { ToasterProvider } from "@/components/ui/toaster"
import { cn } from "@/lib/utils"

import "./globals.css"
import "./attendance.css"

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

const BRAND_ICON_URL = "/brand-icon-white.png?v=3"

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
    icon: [{ url: BRAND_ICON_URL, type: "image/png" }],
    apple: [{ url: BRAND_ICON_URL, type: "image/png" }],
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
      <head>
        {/*
          Paint the brand background on the very first frame.

          On iOS PWA cold-launch (especially in dark mode), the WebView
          shows its default background — black — between the OS splash
          ending and the first CSS rule applying. That gap can be 1+
          seconds on a slow/cold network and is the source of the
          "black screen on open" reports.

          Inline <style> in <head> is applied before any external CSS,
          so the background goes straight from iOS splash → cream →
          ClaimGuard splash overlay, with no black flash in between.
          Values mirror --background in globals.css.
        */}
        <style
          dangerouslySetInnerHTML={{
            __html: `
              html, body { background-color: hsl(268 30% 97%); }
              @media (prefers-color-scheme: dark) {
                html.dark, html.dark body { background-color: hsl(268 40% 7%); }
              }
            `,
          }}
        />
      </head>
      <body className={cn(manropeBody.variable, manrope.variable, "font-body")}>
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
        >
          <ToasterProvider>
            <AppResumeIndicator>
              <ServiceWorkerRegister />
              {children}
            </AppResumeIndicator>
          </ToasterProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
