"use client"

import { useState, useTransition, type FormEvent } from "react"
import { Building2, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/toaster"

import { createCompanyAction } from "./actions"

/**
 * Superadmin-only "Provision new company" form on the /admin/support
 * page. Creates a new Organization + its OWNER account (portal login,
 * password set here) on the chosen plan. Owner can add more companies
 * under themselves afterwards.
 */
export function CreateCompanyCard() {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [orgName, setOrgName] = useState("")
  const [ownerName, setOwnerName] = useState("")
  const [ownerEmail, setOwnerEmail] = useState("")
  const [password, setPassword] = useState("")
  const [plan, setPlan] = useState<"DIY" | "EXPERT">("DIY")
  const [tier, setTier] = useState<"FREE" | "PAID">("FREE")
  const [claims, setClaims] = useState(false)
  const [attendance, setAttendance] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setOrgName("")
    setOwnerName("")
    setOwnerEmail("")
    setPassword("")
    setPlan("DIY")
    setTier("FREE")
    setClaims(false)
    setAttendance(false)
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < 8) {
      setError("Password must be at least 8 characters.")
      return
    }
    startTransition(async () => {
      const res = await createCompanyAction({
        orgName,
        ownerName,
        ownerEmail,
        password,
        plan,
        tier,
        claims,
        attendance,
      })
      if (res.ok) {
        toast({ title: res.message, variant: "success" })
        reset()
      } else {
        setError(res.message)
        toast({ title: res.message, variant: "error" })
      }
    })
  }

  const selectCls =
    "h-11 w-full rounded-2xl border border-border/80 bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Building2 className="h-4 w-4 text-primary" />
          Provision new company
        </CardTitle>
        <CardDescription>
          Create a brand-new company and its owner account (portal login).
          The owner can then add more companies under themselves.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4 pl-1 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="cc-org">Company name</Label>
            <Input
              id="cc-org"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="Acme Sdn Bhd"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cc-owner">Owner name</Label>
            <Input
              id="cc-owner"
              value={ownerName}
              onChange={(e) => setOwnerName(e.target.value)}
              placeholder="Full name"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cc-email">Owner email</Label>
            <Input
              id="cc-email"
              type="email"
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
              placeholder="owner@company.com"
              required
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="cc-pw">Owner password</Label>
            <Input
              id="cc-pw"
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              required
            />
            <p className="text-[11px] text-muted-foreground">
              The owner logs in with this — share it securely. They can
              change it later.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cc-plan">Plan</Label>
            <select
              id="cc-plan"
              className={selectCls}
              value={plan}
              onChange={(e) => setPlan(e.target.value as "DIY" | "EXPERT")}
            >
              <option value="DIY">DIY</option>
              <option value="EXPERT">Expert</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cc-tier">Tier</Label>
            <select
              id="cc-tier"
              className={selectCls}
              value={tier}
              disabled={plan === "EXPERT"}
              onChange={(e) => setTier(e.target.value as "FREE" | "PAID")}
            >
              <option value="FREE">Free</option>
              <option value="PAID">Paid</option>
            </select>
            {plan === "EXPERT" ? (
              <p className="text-[11px] text-muted-foreground">
                Expert plans have no tier.
              </p>
            ) : null}
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>Add-on modules</Label>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={claims}
                  onChange={(e) => setClaims(e.target.checked)}
                />
                Claims
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={attendance}
                  onChange={(e) => setAttendance(e.target.checked)}
                />
                Attendance
              </label>
            </div>
          </div>
          {error ? (
            <p className="text-sm font-medium text-destructive sm:col-span-2">
              {error}
            </p>
          ) : null}
          <div className="sm:col-span-2">
            <Button
              type="submit"
              disabled={
                pending || !orgName || !ownerName || !ownerEmail || !password
              }
              className="gap-2"
            >
              {pending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creating…
                </>
              ) : (
                "Create company"
              )}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
