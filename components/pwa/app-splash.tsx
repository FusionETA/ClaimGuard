import Image from "next/image"

type AppSplashProps = {
  label?: string
}

export function AppSplash({
  label = "Opening ClaimGuard...",
}: AppSplashProps) {
  return (
    <div className="attendance-module flex min-h-[100svh] items-center justify-center bg-background px-6 py-10">
      <div className="w-full max-w-sm rounded-[32px] border border-border/60 bg-card/92 p-8 text-center shadow-panel backdrop-blur-xl">
        <div className="flex justify-center">
          <Image
            src="/brand-logo.png"
            alt="ClaimGuard logo"
            width={1280}
            height={851}
            className="h-auto w-[164px] object-contain"
            priority
          />
        </div>
        <div className="mt-8 flex justify-center">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-primary/20 bg-primary/8">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
          </span>
        </div>
        <p className="mt-5 text-sm font-semibold text-foreground">{label}</p>
        <p className="mt-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">
          Please wait
        </p>
      </div>
    </div>
  )
}
