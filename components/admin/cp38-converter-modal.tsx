"use client"

import * as React from "react"
import { Calculator, Plus, Trash2, Download } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/toaster"
import { cn } from "@/lib/utils"

/**
 * CP38 Converter — modal on the Annual Tax Forms page.
 *
 * LHDN's CP38 (Bahagian PCB/CP38) is a court-ordered tax-debt
 * deduction the engine doesn't yet capture inside the monthly payroll
 * run (the CP39 batch txt embeds CP38 as a column but always zeroes
 * it). For teams that need to file CP38 separately — e.g. while
 * testing the upload portal before going live, or for a one-off court
 * order — this modal lets the admin punch in rows by hand and download
 * a fixed-width 136-char txt file that matches LHDN's e-CP39 spec
 * (header row + N detail rows, CRLF).
 *
 * The generated file is CP38-only: PCB amount column is zero on every
 * row, CP38 column carries the value the admin entered. Same header
 * layout as the regular CP39 (the LHDN portal accepts both flavours
 * through the same upload endpoint).
 *
 * Format reference: see modules/payroll/application/services/
 * report-renderers/pcb-txt.ts for the field-by-field layout. We
 * deliberately re-implement the padding helpers client-side here so
 * the converter works without a server round-trip — the data is
 * admin-entered and isn't persisted.
 */
export function Cp38ConverterModal(props: {
  defaultEmployerNo?: string
  defaultYear?: number
  defaultMonth?: number
}) {
  const { toast } = useToast()
  const [open, setOpen] = React.useState(false)

  // Header inputs.
  const now = new Date()
  const [employerNoHq, setEmployerNoHq] = React.useState(
    props.defaultEmployerNo ?? "",
  )
  const [employerNo, setEmployerNo] = React.useState(
    props.defaultEmployerNo ?? "",
  )
  const [year, setYear] = React.useState<string>(
    String(props.defaultYear ?? now.getFullYear()),
  )
  const [month, setMonth] = React.useState<string>(
    String(props.defaultMonth ?? now.getMonth() + 1).padStart(2, "0"),
  )

  // Detail rows. Start with one blank row so the table never renders
  // empty (the admin can hit "Add row" for more).
  const [rows, setRows] = React.useState<Cp38Row[]>([newRow()])

  function updateRow(idx: number, patch: Partial<Cp38Row>) {
    setRows((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    )
  }

  function addRow() {
    setRows((prev) => [...prev, newRow()])
  }

  function removeRow(idx: number) {
    setRows((prev) =>
      prev.length === 1 ? [newRow()] : prev.filter((_, i) => i !== idx),
    )
  }

  function handleGenerate() {
    // Validate header.
    const hqClean = employerNoHq.replace(/[^0-9]/g, "")
    const branchClean = employerNo.replace(/[^0-9]/g, "")
    if (hqClean.length === 0) {
      toast({ title: "HQ Employer No is required.", variant: "error" })
      return
    }
    if (branchClean.length === 0) {
      toast({ title: "Branch Employer No is required.", variant: "error" })
      return
    }
    const yearNum = Number(year)
    const monthNum = Number(month)
    if (!Number.isInteger(yearNum) || yearNum < 2000 || yearNum > 2100) {
      toast({ title: "Year must be 4 digits (e.g. 2026).", variant: "error" })
      return
    }
    if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
      toast({ title: "Month must be 01–12.", variant: "error" })
      return
    }

    // Filter out empty rows (a CP38 with zero amount makes no sense).
    const populated = rows.filter(
      (r) => parseAmount(r.cp38Amount) > 0 && r.taxRef.trim().length > 0,
    )
    if (populated.length === 0) {
      toast({
        title: "At least one row needs Tax Ref + CP38 amount.",
        variant: "error",
      })
      return
    }

    // Build detail lines + totals.
    const detailLines: string[] = []
    let cp38TotalSen = 0
    let rowNum = 0
    for (const row of populated) {
      rowNum++
      const taxRef = row.taxRef.replace(/[^0-9]/g, "")
      if (taxRef.length === 0) {
        toast({
          title: `Row ${rowNum}: Tax Ref must contain digits.`,
          variant: "error",
        })
        return
      }
      const wifeCode =
        row.wifeCode.trim().length === 0
          ? "0"
          : row.wifeCode.trim().slice(0, 1)
      const name = sanitiseAlphanum(row.name).toUpperCase()
      if (name.length === 0) {
        toast({
          title: `Row ${rowNum}: Employee name is required.`,
          variant: "error",
        })
        return
      }
      const newIc = row.newIc.replace(/[^0-9]/g, "")
      const passport = row.passport.replace(/[^0-9A-Za-z]/g, "")
      const countryCode = row.countryCode.replace(/[^A-Za-z]/g, "").toUpperCase()
      if (newIc.length === 0 && passport.length === 0) {
        toast({
          title: `Row ${rowNum}: New IC or Passport No is required.`,
          variant: "error",
        })
        return
      }
      const employeeNo = sanitiseAlphanum(row.employeeNo)
      if (employeeNo.length === 0) {
        toast({
          title: `Row ${rowNum}: Employee No is required.`,
          variant: "error",
        })
        return
      }
      const cp38Sen = Math.round(parseAmount(row.cp38Amount) * 100)
      cp38TotalSen += cp38Sen

      const detail =
        "D" +
        padZero(taxRef, 10) +
        wifeCode +
        padRight(name, 60) +
        padRight("", 12) + // Old IC — always blank (we never have it for manual entry)
        padRight(newIc, 12) +
        padRight(passport, 12) +
        padRight(countryCode, 2) +
        padZero(0, 8) + // PCB amount — always zero on a CP38-only row
        padZero(cp38Sen, 8) +
        padRight(employeeNo, 10)

      const fixed =
        detail.length === 136 ? detail : detail.padEnd(136, " ").slice(0, 136)
      detailLines.push(fixed)
    }

    const header =
      "H" +
      padZero(hqClean, 10) +
      padZero(branchClean, 10) +
      padZero(yearNum, 4) +
      String(monthNum).padStart(2, "0") +
      padZero(0, 10) + // Total PCB sen — zero on a CP38-only file
      padZero(0, 5) + // PCB Record Count — zero on a CP38-only file
      padZero(cp38TotalSen, 10) +
      padZero(detailLines.length, 5)

    const headerLine =
      header.length === 57 ? header : header.padEnd(57, " ").slice(0, 57)

    const text = [headerLine, ...detailLines].join("\r\n") + "\r\n"
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const fileName = `CP38_${branchClean}_${yearNum}${String(monthNum).padStart(2, "0")}.txt`

    const a = document.createElement("a")
    a.href = url
    a.download = fileName
    a.rel = "noopener"
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1500)

    toast({
      title: `Generated ${fileName} (${detailLines.length} row${detailLines.length === 1 ? "" : "s"}).`,
      variant: "success",
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Calculator className="h-4 w-4" />
          CP38 converter
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>CP38 converter</DialogTitle>
          <DialogDescription>
            Manually enter CP38 court-order rows and download a
            fixed-width TXT formatted for the LHDN e-CP39 upload portal.
            Useful for test uploads or one-off CP38 filings outside the
            normal monthly run.
          </DialogDescription>
        </DialogHeader>

        <div className="nice-scrollbar -mr-2 max-h-[65vh] space-y-5 overflow-y-auto py-2 pr-2">
          {/* Header fields. */}
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              File header
            </h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="space-y-1">
                <Label htmlFor="cp38-hq">HQ Employer No</Label>
                <Input
                  id="cp38-hq"
                  value={employerNoHq}
                  onChange={(e) => setEmployerNoHq(e.target.value)}
                  placeholder="1234567890"
                  inputMode="numeric"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cp38-branch">Branch Employer No</Label>
                <Input
                  id="cp38-branch"
                  value={employerNo}
                  onChange={(e) => setEmployerNo(e.target.value)}
                  placeholder="1234567890"
                  inputMode="numeric"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cp38-year">Deduction year</Label>
                <Input
                  id="cp38-year"
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  placeholder="2026"
                  inputMode="numeric"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cp38-month">Deduction month</Label>
                <Input
                  id="cp38-month"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                  placeholder="06"
                  inputMode="numeric"
                />
              </div>
            </div>
          </section>

          {/* Detail rows. */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Employee rows
              </h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addRow}
                className="gap-1.5"
              >
                <Plus className="h-3.5 w-3.5" />
                Add row
              </Button>
            </div>

            <div className="overflow-x-auto rounded-xl border border-border/60">
              <table className="w-full min-w-[1000px] text-xs">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <Th className="w-10 text-center">#</Th>
                    <Th>Employee Name *</Th>
                    <Th>Tax Ref *</Th>
                    <Th className="w-14">Wife</Th>
                    <Th>New IC</Th>
                    <Th>Passport</Th>
                    <Th className="w-16">Country</Th>
                    <Th>Employee No *</Th>
                    <Th className="text-right">CP38 (RM) *</Th>
                    <Th className="w-10"></Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => (
                    <tr
                      key={row.id}
                      className={cn(
                        "border-t border-border/60",
                        idx % 2 === 1 ? "bg-card/30" : "",
                      )}
                    >
                      <Td className="text-center text-muted-foreground">
                        {idx + 1}
                      </Td>
                      <Td>
                        <CellInput
                          value={row.name}
                          onChange={(v) => updateRow(idx, { name: v })}
                          placeholder="AHMAD BIN ALI"
                        />
                      </Td>
                      <Td>
                        <CellInput
                          value={row.taxRef}
                          onChange={(v) => updateRow(idx, { taxRef: v })}
                          placeholder="SG12345678"
                        />
                      </Td>
                      <Td>
                        <CellInput
                          value={row.wifeCode}
                          onChange={(v) => updateRow(idx, { wifeCode: v })}
                          placeholder="0"
                        />
                      </Td>
                      <Td>
                        <CellInput
                          value={row.newIc}
                          onChange={(v) => updateRow(idx, { newIc: v })}
                          placeholder="901231012345"
                        />
                      </Td>
                      <Td>
                        <CellInput
                          value={row.passport}
                          onChange={(v) => updateRow(idx, { passport: v })}
                          placeholder=""
                        />
                      </Td>
                      <Td>
                        <CellInput
                          value={row.countryCode}
                          onChange={(v) =>
                            updateRow(idx, { countryCode: v })
                          }
                          placeholder=""
                        />
                      </Td>
                      <Td>
                        <CellInput
                          value={row.employeeNo}
                          onChange={(v) =>
                            updateRow(idx, { employeeNo: v })
                          }
                          placeholder="EMP001"
                        />
                      </Td>
                      <Td>
                        <CellInput
                          value={row.cp38Amount}
                          onChange={(v) =>
                            updateRow(idx, { cp38Amount: v })
                          }
                          placeholder="0.00"
                          align="right"
                          inputMode="decimal"
                        />
                      </Td>
                      <Td className="text-center">
                        <button
                          type="button"
                          onClick={() => removeRow(idx)}
                          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          aria-label={`Remove row ${idx + 1}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-[11px] text-muted-foreground">
              Rows with a blank Tax Ref or zero amount are skipped. PCB
              column in the generated file stays zero on every row —
              this is a CP38-only TXT.
            </p>
          </section>
        </div>

        <DialogFooter className="gap-2 sm:flex-row sm:justify-between">
          <Button
            type="button"
            variant="default"
            onClick={handleGenerate}
            className="gap-2"
          >
            <Download className="h-4 w-4" />
            Generate CP38 TXT
          </Button>
          <DialogClose asChild>
            <Button variant="ghost">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type Cp38Row = {
  id: string
  name: string
  taxRef: string
  wifeCode: string
  newIc: string
  passport: string
  countryCode: string
  employeeNo: string
  cp38Amount: string
}

// React-stable id source — we can't use Date.now()/Math.random() (the
// runtime forbids those in some agent-script contexts and they make
// strict-mode double-mounts trip on duplicates). A monotonic ref counter
// is plenty for what's effectively a UI list-key.
let rowIdCounter = 0
function newRow(): Cp38Row {
  rowIdCounter += 1
  return {
    id: `cp38-${rowIdCounter}`,
    name: "",
    taxRef: "",
    wifeCode: "0",
    newIc: "",
    passport: "",
    countryCode: "",
    employeeNo: "",
    cp38Amount: "",
  }
}

function Th(props: React.HTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      {...props}
      className={cn(
        "px-2 py-2 text-left font-semibold uppercase tracking-wide text-[11px]",
        props.className,
      )}
    />
  )
}

function Td(props: React.HTMLAttributes<HTMLTableCellElement>) {
  return <td {...props} className={cn("px-2 py-1.5 align-middle", props.className)} />
}

function CellInput(props: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  align?: "left" | "right"
  inputMode?: "text" | "numeric" | "decimal"
}) {
  return (
    <input
      type="text"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      placeholder={props.placeholder}
      inputMode={props.inputMode ?? "text"}
      className={cn(
        "w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-xs outline-none focus:border-border focus:bg-background",
        props.align === "right" ? "text-right tabular-nums" : "text-left",
      )}
    />
  )
}

function parseAmount(s: string): number {
  const cleaned = s.replace(/[, ]/g, "")
  const n = Number(cleaned)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function padZero(value: string | number, width: number): string {
  const s = String(value)
  if (s.length >= width) return s.slice(s.length - width)
  return s.padStart(width, "0")
}

function padRight(value: string, width: number): string {
  const s = sanitiseAlphanum(value)
  if (s.length >= width) return s.slice(0, width)
  return s.padEnd(width, " ")
}

/**
 * Strip diacritics + collapse non-printable characters. Mirrors the
 * server-side helper in pcb-txt's shared module — LHDN's parser only
 * accepts plain ASCII alphanumerics + space + a few punctuation marks.
 */
function sanitiseAlphanum(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining marks
    .replace(/[^\x20-\x7E]/g, "") // strip non-printable
    .trim()
}
