"use client"

import { useState } from "react"
import { Download, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/toaster"

/**
 * Downloads the employee's individual payslip PDF extracted from the
 * pre-generated bulk payslips ZIP. Shows a spinner while fetching and
 * a toast if the PDF isn't available yet (admin hasn't approved the run
 * or pre-generation is still in progress).
 */
export function DownloadPayslipButton({ payslipId }: { payslipId: string }) {
  const { toast } = useToast()
  const [pending, setPending] = useState(false)

  async function handleDownload() {
    setPending(true)
    try {
      const res = await fetch(`/employee/payslips/${payslipId}/download`)
      if (!res.ok) {
        toast({
          title: "Payslip PDF is not ready yet. Please try again shortly.",
          variant: "error",
        })
        return
      }
      const blob = await res.blob()
      const cd = res.headers.get("Content-Disposition") ?? ""
      const match = cd.match(/filename="?([^";]+)"?/i)
      const fileName = match?.[1] ?? `payslip-${payslipId}.pdf`
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = fileName
      a.rel = "noopener"
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1500)
    } finally {
      setPending(false)
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      onClick={handleDownload}
      disabled={pending}
      className="gap-2"
    >
      {pending ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          Downloading…
        </>
      ) : (
        <>
          <Download className="h-4 w-4" />
          Download PDF
        </>
      )}
    </Button>
  )
}
