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

const BRAND_ICON_URL = "/brand-icon-white.png?v=4"
// Bump this whenever splash assets change. iOS PWAs cache splash bitmaps
// per-install indefinitely, and CDN/browser caches key by URL — appending
// the version forces a fresh fetch on next install / when the meta tags
// load. (Existing iOS PWA installs still need a manual remove + re-add to
// pick up the new splash; that's an iOS limitation we can't bypass.)
const SPLASH_VERSION = "?v=2"

// iOS PWA splash screens. iOS Safari ignores the manifest's background_color
// and icons for splash purposes — the only way to get a real splash is to
// supply one image per device size, each with a media query that matches the
// device's CSS dimensions, pixel ratio, and orientation. Without these the
// WebView shows its default (black in dark mode) until the first paint.
//
// Generated from /public/brand-logo.png onto a cream background that matches
// --background in globals.css. Portrait only — the app is mobile-portrait.
const APPLE_SPLASH_SCREENS: Array<{
  url: string
  width: number
  height: number
  cssWidth: number
  cssHeight: number
  pixelRatio: number
}> = [
  // iPhones
  { url: "/splash/apple-splash-1320x2868.png", width: 1320, height: 2868, cssWidth: 440, cssHeight: 956, pixelRatio: 3 },
  { url: "/splash/apple-splash-1206x2622.png", width: 1206, height: 2622, cssWidth: 402, cssHeight: 874, pixelRatio: 3 },
  { url: "/splash/apple-splash-1290x2796.png", width: 1290, height: 2796, cssWidth: 430, cssHeight: 932, pixelRatio: 3 },
  { url: "/splash/apple-splash-1179x2556.png", width: 1179, height: 2556, cssWidth: 393, cssHeight: 852, pixelRatio: 3 },
  { url: "/splash/apple-splash-1284x2778.png", width: 1284, height: 2778, cssWidth: 428, cssHeight: 926, pixelRatio: 3 },
  { url: "/splash/apple-splash-1170x2532.png", width: 1170, height: 2532, cssWidth: 390, cssHeight: 844, pixelRatio: 3 },
  { url: "/splash/apple-splash-1080x2340.png", width: 1080, height: 2340, cssWidth: 360, cssHeight: 780, pixelRatio: 3 },
  { url: "/splash/apple-splash-1125x2436.png", width: 1125, height: 2436, cssWidth: 375, cssHeight: 812, pixelRatio: 3 },
  { url: "/splash/apple-splash-1242x2688.png", width: 1242, height: 2688, cssWidth: 414, cssHeight: 896, pixelRatio: 3 },
  { url: "/splash/apple-splash-828x1792.png",  width:  828, height: 1792, cssWidth: 414, cssHeight: 896, pixelRatio: 2 },
  { url: "/splash/apple-splash-1242x2208.png", width: 1242, height: 2208, cssWidth: 414, cssHeight: 736, pixelRatio: 3 },
  { url: "/splash/apple-splash-750x1334.png",  width:  750, height: 1334, cssWidth: 375, cssHeight: 667, pixelRatio: 2 },
  { url: "/splash/apple-splash-640x1136.png",  width:  640, height: 1136, cssWidth: 320, cssHeight: 568, pixelRatio: 2 },
  // iPads
  { url: "/splash/apple-splash-2048x2732.png", width: 2048, height: 2732, cssWidth: 1024, cssHeight: 1366, pixelRatio: 2 },
  { url: "/splash/apple-splash-1668x2388.png", width: 1668, height: 2388, cssWidth:  834, cssHeight: 1194, pixelRatio: 2 },
  { url: "/splash/apple-splash-1668x2224.png", width: 1668, height: 2224, cssWidth:  834, cssHeight: 1112, pixelRatio: 2 },
  { url: "/splash/apple-splash-1536x2048.png", width: 1536, height: 2048, cssWidth:  768, cssHeight: 1024, pixelRatio: 2 },
  { url: "/splash/apple-splash-1488x2266.png", width: 1488, height: 2266, cssWidth:  744, cssHeight: 1133, pixelRatio: 2 },
]

export const metadata: Metadata = {
  title: {
    default: "AltomateHR",
    template: "%s | AltomateHR",
  },
  description:
    "AltomateHR is a dual-portal expense claims platform for employees and administrators, built with Next.js, shadcn/ui, and Prisma.",
  applicationName: "AltomateHR",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "AltomateHR",
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
          AltomateHR splash overlay, with no black flash in between.
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
        {/*
          The "screen and" prefix is required — Safari silently ignores
          apple-touch-startup-image links whose media query starts with the
          bare parenthesised form. This caught us with iPhone 16 in PWA mode.
        */}
        {APPLE_SPLASH_SCREENS.map((splash) => (
          <link
            key={splash.url}
            rel="apple-touch-startup-image"
            href={`${splash.url}${SPLASH_VERSION}`}
            media={`screen and (device-width: ${splash.cssWidth}px) and (device-height: ${splash.cssHeight}px) and (-webkit-device-pixel-ratio: ${splash.pixelRatio}) and (orientation: portrait)`}
          />
        ))}
        {/*
          Next.js 15 emits only the new "mobile-web-app-capable" meta tag for
          appleWebApp.capable: true. iOS Safari's PWA splash pipeline still
          checks for the apple-prefixed legacy tag, so we add it manually here.
          Without this, iOS may refuse to render apple-touch-startup-image
          even when a link's media query matches the device exactly.
        */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
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
