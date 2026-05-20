"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Watches a scroll container and reports whether each axis is currently
 * overflowing. Used to drive `data-overflowing-x` / `-y` so CSS can switch
 * `overflow: auto` to `scroll` only when content actually overflows.
 */
export function useOverflowing(ref: React.RefObject<HTMLElement | null>) {
  const [state, setState] = React.useState({
    overflowingX: false,
    overflowingY: false,
  })

  React.useEffect(() => {
    const el = ref.current
    if (!el) return

    const measure = () => {
      const overflowingX = el.scrollWidth > el.clientWidth + 1
      const overflowingY = el.scrollHeight > el.clientHeight + 1
      setState((prev) =>
        prev.overflowingX === overflowingX &&
        prev.overflowingY === overflowingY
          ? prev
          : { overflowingX, overflowingY },
      )
    }

    measure()

    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)

    return () => ro.disconnect()
  }, [ref])

  return state
}

function useHorizontalIndicator(ref: React.RefObject<HTMLElement | null>) {
  const trackRef = React.useRef<HTMLDivElement | null>(null)
  const dragRef = React.useRef<{
    startX: number
    startScrollLeft: number
    maxThumbLeft: number
    maxScrollLeft: number
  } | null>(null)
  const [state, setState] = React.useState({
    scrollLeft: 0,
    scrollWidth: 0,
    clientWidth: 0,
    trackWidth: 0,
  })

  const measure = React.useCallback(() => {
    const el = ref.current
    if (!el) return
    setState({
      scrollLeft: el.scrollLeft,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      trackWidth: trackRef.current?.clientWidth ?? 0,
    })
  }, [ref])

  React.useEffect(() => {
    const el = ref.current
    if (!el) return

    measure()
    el.addEventListener("scroll", measure, { passive: true })

    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    if (trackRef.current) ro.observe(trackRef.current)

    return () => {
      el.removeEventListener("scroll", measure)
      ro.disconnect()
    }
  }, [measure, ref])

  React.useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current
      const el = ref.current
      if (!drag || !el) return

      const delta = event.clientX - drag.startX
      const ratio = drag.maxThumbLeft > 0 ? delta / drag.maxThumbLeft : 0
      el.scrollLeft = drag.startScrollLeft + ratio * drag.maxScrollLeft
    }
    const onPointerUp = () => {
      dragRef.current = null
      document.body.style.userSelect = ""
    }

    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
    return () => {
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", onPointerUp)
      document.body.style.userSelect = ""
    }
  }, [ref])

  const overflowingX = state.scrollWidth > state.clientWidth + 1
  const maxScrollLeft = Math.max(0, state.scrollWidth - state.clientWidth)
  const thumbWidth =
    overflowingX && state.trackWidth > 0
      ? Math.max(44, state.trackWidth * (state.clientWidth / state.scrollWidth))
      : 0
  const maxThumbLeft = Math.max(0, state.trackWidth - thumbWidth)
  const thumbLeft =
    maxScrollLeft > 0 ? (state.scrollLeft / maxScrollLeft) * maxThumbLeft : 0

  const setTrackRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      trackRef.current = node
      measure()
    },
    [measure],
  )

  const scrollToTrackPoint = React.useCallback(
    (clientX: number) => {
      const el = ref.current
      const track = trackRef.current
      if (!el || !track || maxScrollLeft <= 0 || maxThumbLeft <= 0) return

      const rect = track.getBoundingClientRect()
      const nextThumbLeft = Math.min(
        maxThumbLeft,
        Math.max(0, clientX - rect.left - thumbWidth / 2),
      )
      el.scrollLeft = (nextThumbLeft / maxThumbLeft) * maxScrollLeft
    },
    [maxScrollLeft, maxThumbLeft, ref, thumbWidth],
  )

  const beginDrag = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      dragRef.current = {
        startX: event.clientX,
        startScrollLeft: ref.current?.scrollLeft ?? 0,
        maxThumbLeft,
        maxScrollLeft,
      }
      document.body.style.userSelect = "none"
    },
    [maxScrollLeft, maxThumbLeft, ref],
  )

  return {
    setTrackRef,
    overflowingX,
    thumbLeft,
    thumbWidth,
    scrollToTrackPoint,
    beginDrag,
  }
}

const ScrollArea = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, children, ...props }, ref) => {
  const localRef = React.useRef<HTMLDivElement | null>(null)
  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      localRef.current = node
      if (typeof ref === "function") {
        ref(node)
      } else if (ref) {
        ref.current = node
      }
    },
    [ref],
  )
  const { overflowingX, overflowingY } = useOverflowing(localRef)
  const horizontal = useHorizontalIndicator(localRef)

  return (
    <div className="relative">
      <div
        ref={setRefs}
        data-overflowing-x={overflowingX ? "true" : undefined}
        data-overflowing-y={overflowingY ? "true" : undefined}
        data-custom-horizontal-scrollbar={overflowingX ? "true" : undefined}
        className={cn("nice-scrollbar", className)}
        {...props}
      >
        {children}
      </div>
      {horizontal.overflowingX ? (
        <div
          ref={horizontal.setTrackRef}
          className="pointer-events-auto absolute inset-x-4 bottom-1 z-40 h-3 cursor-pointer rounded-full bg-muted/75 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.65)]"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              horizontal.scrollToTrackPoint(event.clientX)
            }
          }}
          aria-hidden="true"
        >
          <div
            className="absolute top-1/2 h-1.5 -translate-y-1/2 cursor-grab rounded-full bg-muted-foreground/55 transition-colors active:cursor-grabbing active:bg-muted-foreground/80"
            style={{
              width: horizontal.thumbWidth,
              transform: `translate(${horizontal.thumbLeft}px, -50%)`,
            }}
            onPointerDown={horizontal.beginDrag}
          />
        </div>
      ) : null}
    </div>
  )
})
ScrollArea.displayName = "ScrollArea"

export { ScrollArea }
