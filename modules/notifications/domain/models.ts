/// Notification types persisted in the `Notification` table. Keep in
/// lock-step with the `NotificationType` enum in prisma/schema.prisma.
export const notificationTypes = [
  "CLAIM_SUBMITTED",
  "CLAIM_REVIEWED",
  "ATTENDANCE_APPROVAL",
  "TEMPORARY_REVIEW",
] as const

export type NotificationType = (typeof notificationTypes)[number]

/// App-friendly projection of a `Notification` row. Dates are ISO strings
/// so the shape is safe to serialise straight to the client.
export type NotificationView = {
  id: string
  type: NotificationType
  title: string
  body: string
  /// Relative URL to open when the notification is clicked, or null.
  url: string | null
  /// True once the user has acknowledged it.
  read: boolean
  /// ISO datetime the notification was created.
  createdAt: string
}
