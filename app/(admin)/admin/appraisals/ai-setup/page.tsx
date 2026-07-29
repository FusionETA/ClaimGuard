import { redirect } from "next/navigation"

import { getCurrentSession } from "@/lib/auth/session"

import { AiSetupClient } from "./ai-setup-client"

// The admin group layout already enforces the ADMIN role (accepts OWNER);
// this page only needs a session-existence check (matches other admin pages).
export default async function AiSetupPage() {
  const session = await getCurrentSession()
  if (!session) redirect("/login")
  return <AiSetupClient />
}
