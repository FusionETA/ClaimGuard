import Image from "next/image"

type AppSplashProps = {
  label?: string
  onManualReload?: () => void
}

export function AppSplash({
  label = "Opening ClaimGuard...",
  onManualReload,
}: AppSplashProps) {
  return (
    // NOTE: do NOT include `attendance-module` here. That class applies its
    // theme tokens AND `background-color: transparent`, which would let the
    // underlying app shell bleed through this overlay on mobile.
    <div className="flex min-h-[100svh] w-full items-center justify-center bg-background px-6 py-10">
      <div className="w-full max-w-[28rem] rounded-[32px] border border-border/60 bg-card/92 px-8 py-9 text-center shadow-panel backdrop-blur-xl">
        <div className="flex justify-center">
          <Image
            src="/brand-icon.png"
            alt="ClaimGuard logo"
            width={512}
            height={512}
            className="h-auto w-[86px] object-contain"
            priority
          />
        </div>
        <p className="mt-6 text-[2rem] font-black uppercase tracking-[0.08em] text-primary">
          ClaimGuard
        </p>
        <div className="mt-5 flex justify-center">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-primary/20 bg-primary/8">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
          </span>
        </div>
        <p className="mt-5 text-base font-semibold text-foreground">{label}</p>
        <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Please wait
        </p>
        {onManualReload ? (
          <button
            type="button"
            onClick={onManualReload}
            className="mt-6 inline-flex w-full items-center justify-center rounded-full border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm font-semibold text-primary transition hover:bg-primary/10 active:bg-primary/15"
          >
            Still loading? Tap to reload
          </button>
        ) : null}
      </div>
    </div>
  )
}
