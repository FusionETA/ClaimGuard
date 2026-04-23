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
