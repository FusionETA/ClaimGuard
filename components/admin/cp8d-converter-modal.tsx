"use client"

import * as React from "react"
import JSZip from "jszip"
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
import { NativeSelect } from "@/components/admin/payroll-form-controls"
import { useToast } from "@/components/ui/toaster"
import { cn } from "@/lib/utils"

/**
 * CP8D Converter — modal on the Annual Tax Forms page.
 *
 * LHDN's CP8D is the per-employee annual particulars schedule filed
 * alongside Form E (Borang E) by 31 March of the following year. The
 * e-CP8D upload takes two pipe-delimited TXT files:
 *
 *   M{employerNo}_{year}.TXT — employer master (one line)
 *     {employerNo}|{employerName}|{year}
 *
 *   P{employerNo}_{year}.TXT — employee particulars (one line per
 *     employee, 16 columns + trailing pipe). Column layout matches the
 *     server-side renderer in
 *     modules/payroll/application/services/report-renderers/cp8d-employee-txt.ts.
 *
 * The annual downloads card above this modal generates the same two
 * files from real payroll data; this modal lets the admin hand-enter
 * rows when:
 *   - they're testing the LHDN upload portal before going live,
 *   - they didn't run payroll for that year through this system but
 *     still need to file (mid-year cutover),
 *   - they're filing a one-off correction for a single employee.
 *
 * Output: a single .zip containing both M and P files. The admin then
 * uploads each one separately to the LHDN e-CP8D portal.
 */
export function Cp8dConverterModal(props: {
  defaultEmployerNo?: string
  defaultEmployerName?: string
  defaultYear?: number
}) {
  const { toast } = useToast()
  const [open, setOpen] = React.useState(false)

  const now = new Date()
  const [employerNo, setEmployerNo] = React.useState(
    props.defaultEmployerNo ?? "",
  )
  const [employerName, setEmployerName] = React.useState(
    props.defaultEmployerName ?? "",
  )
  const [year, setYear] = React.useState<string>(
    String(props.defaultYear ?? now.getFullYear()),
  )

  const [rows, setRows] = React.useState<Cp8dRow[]>([newRow()])

  function updateRow(idx: number, patch: Partial<Cp8dRow>) {
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

  async function handleGenerate() {
    const employerNoClean = employerNo.replace(/[^0-9]/g, "")
    if (employerNoClean.length === 0) {
      toast({ title: "Employer E-number is required.", variant: "error" })
      return
    }
    const employerNameClean = sanitiseAlphanum(employerName).toUpperCase()
    if (employerNameClean.length === 0) {
      toast({ title: "Employer name is required.", variant: "error" })
      return
    }
    const yearNum = Number(year)
    if (!Number.isInteger(yearNum) || yearNum < 2000 || yearNum > 2100) {
      toast({ title: "Year must be 4 digits (e.g. 2026).", variant: "error" })
      return
    }

    // Skip blank rows (no name + no tax ref = clearly an empty slot the
    // admin didn't fill). A row that has identity but zero amounts is
    // still kept — sometimes LHDN wants a zero-PCB row to confirm the
    // employee was on payroll.
    const populated = rows.filter(
      (r) => r.name.trim().length > 0 || r.taxRef.trim().length > 0,
    )
    if (populated.length === 0) {
      toast({
        title: "Add at least one employee row.",
        variant: "error",
      })
      return
    }

    // Build P-file lines.
    const pLines: string[] = []
    let rowNum = 0
    for (const row of populated) {
      rowNum++
      const name = sanitiseAlphanum(row.name).toUpperCase()
      if (name.length === 0) {
        toast({
          title: `Row ${rowNum}: Employee name is required.`,
          variant: "error",
        })
        return
      }
      const taxRef = row.taxRef.replace(/[^0-9]/g, "")
      if (taxRef.length === 0) {
        toast({
          title: `Row ${rowNum}: Income Tax No. is required.`,
          variant: "error",
        })
        return
      }
      const ic = row.newIc.replace(/[^0-9]/g, "")
      if (ic.length === 0) {
        toast({
          title: `Row ${rowNum}: New IC is required.`,
          variant: "error",
        })
        return
      }
      const category = row.category === "2" || row.category === "3" ? row.category : "1"
      const taxBorne = row.taxBorne === "1" ? "1" : "2"
      const children = String(Math.max(0, parseInt(row.children || "0", 10) || 0))
      const childRelief = String(Math.max(0, Math.round(parseAmount(row.childRelief))))
      const annualGross = String(Math.max(0, Math.round(parseAmount(row.annualGross))))
      const epf = String(Math.max(0, Math.round(parseAmount(row.epf))))
      const pcb = Math.max(0, parseAmount(row.pcb)).toFixed(2)

      // 16 cols + trailing pipe, matching cp8d-employee-txt.ts.
      const cols = [
        name,        // 1
        taxRef,      // 2
        ic,          // 3
        category,    // 4
        taxBorne,    // 5
        children,    // 6
        childRelief, // 7
        annualGross, // 8
        "",          // 9
        "",          // 10
        "",          // 11
        "",          // 12
        "",          // 13
        epf,         // 14
        "",          // 15
        pcb,         // 16
      ]
      pLines.push(cols.join("|") + "|")
    }

    const mLine = `${employerNoClean}|${employerNameClean}|${yearNum}\r\n`
    const pText = pLines.join("\r\n") + "\r\n"

    const mFileName = `M${employerNoClean}_${yearNum}.TXT`
    const pFileName = `P${employerNoClean}_${yearNum}.TXT`

    const zip = new JSZip()
    zip.file(mFileName, mLine)
    zip.file(pFileName, pText)
    const zipBlob = await zip.generateAsync({ type: "blob" })

    const zipName = `CP8D_${employerNoClean}_${yearNum}.zip`
    const url = URL.createObjectURL(zipBlob)
    const a = document.createElement("a")
    a.href = url
    a.download = zipName
    a.rel = "noopener"
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1500)

    toast({
      title: `Generated ${zipName} (${pLines.length} employee row${pLines.length === 1 ? "" : "s"}).`,
      variant: "success",
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Calculator className="h-4 w-4" />
          CP8D converter
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>CP8D converter</DialogTitle>
          <DialogDescription>
            Manually enter per-employee annual CP8D rows and download a
            ZIP containing the M (employer master) and P (employee
            particulars) TXT files for LHDN&apos;s e-CP8D upload portal.
            Useful for mid-year cutovers, one-off corrections, or testing
            the upload before running a full Jan–Dec payroll cycle.
          </DialogDescription>
        </DialogHeader>

        <div className="nice-scrollbar -mr-2 max-h-[65vh] space-y-5 overflow-y-auto py-2 pr-2">
          {/* Header fields. */}
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Employer master (M file)
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="cp8d-employer-no">Employer E-number</Label>
                <Input
                  id="cp8d-employer-no"
                  value={employerNo}
                  onChange={(e) => setEmployerNo(e.target.value)}
                  placeholder="0009089151"
                  inputMode="numeric"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cp8d-employer-name">Employer name</Label>
                <Input
                  id="cp8d-employer-name"
                  value={employerName}
                  onChange={(e) => setEmployerName(e.target.value)}
                  placeholder="DEMO SDN BHD"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cp8d-year">Year of remuneration</Label>
                <Input
                  id="cp8d-year"
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  placeholder="2026"
                  inputMode="numeric"
                />
              </div>
            </div>
          </section>

          {/* Detail rows. */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Employee particulars (P file)
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
              <table className="w-full min-w-[1200px] text-xs">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <Th className="w-10 text-center">#</Th>
                    <Th>Employee Name *</Th>
                    <Th>Tax Ref *</Th>
                    <Th>New IC *</Th>
                    <Th className="w-20">Category *</Th>
                    <Th className="w-24">Tax borne</Th>
                    <Th className="w-16 text-right">Children</Th>
                    <Th className="text-right">Child relief (RM)</Th>
                    <Th className="text-right">Gross (RM) *</Th>
                    <Th className="text-right">EPF (RM)</Th>
                    <Th className="text-right">PCB (RM)</Th>
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
                          value={row.newIc}
                          onChange={(v) => updateRow(idx, { newIc: v })}
                          placeholder="901231012345"
                        />
                      </Td>
                      <Td>
                        <NativeSelect
                          value={row.category}
                          onChange={(e) =>
                            updateRow(idx, {
                              category: e.target.value as "1" | "2" | "3",
                            })
                          }
                          className="h-8 text-xs"
                        >
                          <option value="1">1 — Single</option>
                          <option value="2">2 — Married, sole earner</option>
                          <option value="3">3 — Both working / other</option>
                        </NativeSelect>
                      </Td>
                      <Td>
                        <NativeSelect
                          value={row.taxBorne}
                          onChange={(e) =>
                            updateRow(idx, {
                              taxBorne: e.target.value as "1" | "2",
                            })
                          }
                          className="h-8 text-xs"
                        >
                          <option value="2">No</option>
                          <option value="1">Yes</option>
                        </NativeSelect>
                      </Td>
                      <Td>
                        <CellInput
                          value={row.children}
                          onChange={(v) => updateRow(idx, { children: v })}
                          placeholder="0"
                          align="right"
                          inputMode="numeric"
                        />
                      </Td>
                      <Td>
                        <CellInput
                          value={row.childRelief}
                          onChange={(v) =>
                            updateRow(idx, { childRelief: v })
                          }
                          placeholder="0"
                          align="right"
                          inputMode="decimal"
                        />
                      </Td>
                      <Td>
                        <CellInput
                          value={row.annualGross}
                          onChange={(v) =>
                            updateRow(idx, { annualGross: v })
                          }
                          placeholder="0"
                          align="right"
                          inputMode="decimal"
                        />
                      </Td>
                      <Td>
                        <CellInput
                          value={row.epf}
                          onChange={(v) => updateRow(idx, { epf: v })}
                          placeholder="0"
                          align="right"
                          inputMode="decimal"
                        />
                      </Td>
                      <Td>
                        <CellInput
                          value={row.pcb}
                          onChange={(v) => updateRow(idx, { pcb: v })}
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
              Category 1 = single, 2 = married &amp; sole earner, 3 = both
              spouses working / divorced / widowed / single with children.
              Blank rows (no name and no tax ref) are skipped.
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
            Generate CP8D ZIP
          </Button>
          <DialogClose asChild>
            <Button variant="ghost">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type Cp8dRow = {
  id: string
  name: string
  taxRef: string
  newIc: string
  category: "1" | "2" | "3"
  taxBorne: "1" | "2"
  children: string
  childRelief: string
  annualGross: string
  epf: string
  pcb: string
}

// Monotonic id source — Date.now()/Math.random() are forbidden in some
// agent-script contexts, and strict-mode double mounts trip on dup keys.
let rowIdCounter = 0
function newRow(): Cp8dRow {
  rowIdCounter += 1
  return {
    id: `cp8d-${rowIdCounter}`,
    name: "",
    taxRef: "",
    newIc: "",
    category: "1",
    taxBorne: "2",
    children: "0",
    childRelief: "",
    annualGross: "",
    epf: "",
    pcb: "",
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

/**
 * Strip diacritics + collapse non-printable characters so the output
 * survives LHDN's parser (plain ASCII only).
 */
function sanitiseAlphanum(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
}
