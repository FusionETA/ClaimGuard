/**
 * Form-state shapes for the forgot-password flow.
 *
 *   step 1: request code (email)
 *   step 2: verify code + set new password
 *
 * Both follow the same minimal `FormState` shape the rest of the app
 * uses with `useActionState`.
 */

export type RequestCodeFormState = {
  status: "idle" | "success" | "error"
  message?: string
  /// Echoed back so the input stays filled if validation fails.
  email?: string
}

export const initialRequestCodeFormState: RequestCodeFormState = {
  status: "idle",
}

export type ResetPasswordFormState = {
  status: "idle" | "error"
  message?: string
  errors?: {
    code?: string
    newPassword?: string
    confirmPassword?: string
  }
  values?: {
    code?: string
  }
}

export const initialResetPasswordFormState: ResetPasswordFormState = {
  status: "idle",
}
