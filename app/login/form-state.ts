export type LoginFormState = {
  status: "idle" | "error"
  message: string
  values: {
    email: string
  }
  errors: {
    email?: string
    password?: string
  }
}

export const initialLoginFormState: LoginFormState = {
  status: "idle",
  message: "",
  values: {
    email: "",
  },
  errors: {},
}

/**
 * Form-state shape for the change-password dialog. Lives here rather
 * than in actions.ts so the file can be imported from client components
 * without dragging the "use server" boundary along — Next.js rejects
 * non-function exports from "use server" modules at build time.
 */
export type ChangePasswordFormState = {
  status: "idle" | "success" | "error"
  message?: string
  errors?: {
    currentPassword?: string
    newPassword?: string
    confirmPassword?: string
  }
}

export const initialChangePasswordFormState: ChangePasswordFormState = {
  status: "idle",
}
