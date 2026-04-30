"use server"

import { redirect } from "next/navigation"
import { z } from "zod"

import {
  initialLoginFormState,
  type LoginFormState,
} from "@/app/login/form-state"
import { authenticateUser } from "@/lib/auth/authenticate"
import {
  clearUserSession,
  createUserSession,
  getCurrentSession,
  getHomePathForRole,
} from "@/lib/auth/session"
import { clearAdminStore, clearEmployeeStore } from "@/lib/app-store"

const loginSchema = z.object({
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
})

export async function loginAction(
  _previousState: LoginFormState,
  formData: FormData
): Promise<LoginFormState> {
  const values = {
    email: String(formData.get("email") ?? "").trim(),
    password: String(formData.get("password") ?? ""),
  }

  const parsed = loginSchema.safeParse(values)

  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors
    return {
      status: "error",
      message: "Please check the highlighted fields and try again.",
      values: { email: values.email },
      errors: {
        email: fieldErrors.email?.[0],
        password: fieldErrors.password?.[0],
      },
    }
  }

  // 1. Check credentials against the database.
  const result = await authenticateUser(parsed.data)

  if (!result.success) {
    return {
      status: "error",
      message: result.message,
      values: { email: parsed.data.email },
      errors: {},
    }
  }

  // 2. Create the session cookie.
  await createUserSession(result.user)

  // 3. Redirect to the correct portal.
  // NOTE: We intentionally do NOT prefetch data here. The prefetch was
  // blocking DB connections during login (causing pool exhaustion / 504s
  // under concurrent logins), and the in-memory store is per-Vercel-instance
  // so it was unreliable in multi-instance deployments anyway.
  // Pages lazy-load their own data from the DB on first visit.
  redirect(getHomePathForRole(result.user.role))
}

export async function logoutAction() {
  // Clear this user's data from the in-memory store.
  const session = await getCurrentSession()

  if (session) {
    if (session.role === "EMPLOYEE" || session.role === "SUPERVISOR") {
      clearEmployeeStore(session.email)
    } else {
      clearAdminStore()
    }
  }

  await clearUserSession()
  redirect("/login")
}
