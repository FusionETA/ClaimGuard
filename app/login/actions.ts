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
import { loadAdminData, loadEmployeeData } from "@/lib/load-user-data"

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

  // 3. Pre-fetch all data for this user so every page loads instantly.
  try {
    if (result.user.role === "EMPLOYEE" || result.user.role === "SUPERVISOR") {
      await loadEmployeeData(result.user.email)
    } else {
      await loadAdminData(result.user.email)
    }
  } catch {
    // If pre-fetch fails, pages will lazy-load from DB on first visit.
    // Don't block the login.
  }

  // 4. Redirect to the correct portal.
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
