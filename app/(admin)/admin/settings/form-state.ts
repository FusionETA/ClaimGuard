export type SettingsActionState = {
  status: "idle" | "success" | "error"
  message: string
}

export const initialSettingsActionState: SettingsActionState = {
  status: "idle",
  message: "",
}
