"use client"

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Camera, RotateCcw, X } from "lucide-react"

export function CameraCaptureModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: (file: File) => void
  onCancel: () => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [captured, setCaptured] = useState<string | null>(null)
  const [starting, setStarting] = useState(true)
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  useEffect(() => {
    let cancelled = false
    let activeStream: MediaStream | null = null
    async function start() {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setError("Camera not supported on this device.")
        setStarting(false)
        return
      }
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 960 } },
          audio: false,
        })
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        activeStream = s
        setStream(s)
        if (videoRef.current) {
          videoRef.current.srcObject = s
          await videoRef.current.play().catch(() => undefined)
        }
      } catch (err) {
        setError(
          err instanceof Error && err.name === "NotAllowedError"
            ? "Camera permission denied. Enable it in your browser settings."
            : "Couldn't open the camera. Try again.",
        )
      } finally {
        if (!cancelled) setStarting(false)
      }
    }
    void start()
    return () => {
      cancelled = true
      if (activeStream) activeStream.getTracks().forEach((t) => t.stop())
    }
  }, [])

  function capture() {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    const w = video.videoWidth || 1280
    const h = video.videoHeight || 960
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.drawImage(video, 0, 0, w, h)
    setCaptured(canvas.toDataURL("image/jpeg", 0.85))
  }

  function retake() {
    setCaptured(null)
  }

  function confirm() {
    const canvas = canvasRef.current
    if (!captured || !canvas) return
    if (stream) stream.getTracks().forEach((t) => t.stop())
    canvas.toBlob((blob) => {
      if (!blob) return
      const file = new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" })
      onConfirm(file)
    }, "image/jpeg", 0.85)
  }

  function cancel() {
    if (stream) stream.getTracks().forEach((t) => t.stop())
    onCancel()
  }

  if (!mounted) return null

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-background/80 p-4 backdrop-blur-sm"
    >
      <div className="my-auto w-full max-w-md overflow-hidden rounded-[24px] border border-border/60 bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <p className="text-sm font-bold text-foreground">Take a photo</p>
          <button
            type="button"
            onClick={cancel}
            className="rounded-full p-1.5 text-muted-foreground hover:bg-muted"
            aria-label="Cancel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="relative aspect-[4/3] w-full bg-black">
          {error ? (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm font-semibold text-destructive">
              {error}
            </div>
          ) : captured ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={captured} alt="Preview" className="h-full w-full object-cover" />
          ) : (
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="h-full w-full object-cover"
            />
          )}
          {starting && !error ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/30 text-xs font-semibold text-white">
              Starting camera…
            </div>
          ) : null}
          <canvas ref={canvasRef} className="hidden" />
        </div>

        <div className="flex gap-2 border-t border-border/60 p-3">
          {captured ? (
            <>
              <button
                type="button"
                onClick={retake}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-[14px] border border-border/70 bg-card py-2.5 text-xs font-bold text-foreground hover:bg-muted"
              >
                <RotateCcw className="h-4 w-4" />
                Retake
              </button>
              <button
                type="button"
                onClick={confirm}
                className="flex-1 rounded-[14px] bg-primary py-2.5 text-xs font-bold text-primary-foreground hover:bg-primary/90"
              >
                Use this photo
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={capture}
              disabled={starting || !!error}
              className="flex flex-1 items-center justify-center gap-2 rounded-[14px] bg-primary py-2.5 text-xs font-bold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <Camera className="h-4 w-4" />
              Capture
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
