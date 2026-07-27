import { Icon } from "./_ui"

/** `?phase=` slug used by the confirmation screen. */
export type ConfirmPhase = "self" | "reviewer" | "partner"

type PhaseConfig = {
  icon: string
  iconBg: string
  iconColor: string
  title: string
  message: string
  next: Array<{ icon: string; text: string }>
  showPdf: boolean
}

const CONFIG: Record<ConfirmPhase, PhaseConfig> = {
  self: {
    icon: "check_circle",
    iconBg: "bg-amber-100",
    iconColor: "text-amber-600",
    title: "Self-Assessment Submitted!",
    message:
      "Your self-assessment has been recorded. Your reviewer has been notified and will complete their evaluation next.",
    next: [
      { icon: "person", text: "Reviewer will be notified to complete their evaluation" },
      { icon: "group", text: "Partner review will follow after the reviewer completes their scores" },
      { icon: "analytics", text: "Final summary will be available on your dashboard once all phases are complete" },
    ],
    showPdf: false,
  },
  reviewer: {
    icon: "task_alt",
    iconBg: "bg-emerald-100",
    iconColor: "text-emerald-600",
    title: "Evaluation Completed!",
    message:
      "Your reviewer evaluation has been submitted. The partner has been notified to begin their review.",
    next: [
      { icon: "handshake", text: "Partner has been notified to begin their review" },
      { icon: "analytics", text: "Final summary will be generated once the partner completes their review" },
      { icon: "notifications", text: "You will be notified when the full cycle is complete" },
    ],
    showPdf: false,
  },
  partner: {
    icon: "stars",
    iconBg: "bg-purple-100",
    iconColor: "text-purple-600",
    title: "Review Finalized!",
    message:
      "The partner review is complete. All three appraisal phases are now finished. The final summary is now available.",
    next: [
      { icon: "analytics", text: "Combined appraisal summary is now visible on the dashboard" },
      { icon: "picture_as_pdf", text: "A PDF report has been generated" },
      { icon: "notifications", text: "All participants have been notified of the completed cycle" },
    ],
    showPdf: true,
  },
}

export function ConfirmationScreen({
  phase,
  referenceNumber,
}: {
  phase: ConfirmPhase
  referenceNumber?: string
}) {
  const cfg = CONFIG[phase]
  return (
    <div className="mx-auto w-full max-w-lg px-6 py-12">
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="p-10 text-center">
          <div className={`mx-auto mb-6 flex h-24 w-24 items-center justify-center rounded-full ${cfg.iconBg}`}>
            <Icon name={cfg.icon} filled className={`text-5xl ${cfg.iconColor}`} />
          </div>

          <h1 className="mb-3 text-3xl font-extrabold text-slate-900">{cfg.title}</h1>
          <p className="mx-auto mb-8 max-w-sm text-base leading-relaxed text-slate-500">{cfg.message}</p>

          <div className="mb-8 rounded-xl bg-slate-50 p-5 text-left">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
              What happens next
            </p>
            <div className="space-y-2">
              {cfg.next.map((item, i) => (
                <div key={i} className="flex items-start gap-2.5 text-sm text-slate-600">
                  <Icon name={item.icon} className="mt-0.5 shrink-0 text-base text-primary" />
                  <span>{item.text}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col justify-center gap-3 sm:flex-row">
            {cfg.showPdf ? (
              <button className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-6 py-2.5 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50">
                <Icon name="picture_as_pdf" className="text-lg" />
                Download PDF
              </button>
            ) : null}
            <a
              href="/employee/appraisals"
              className="flex items-center justify-center gap-2 rounded-xl bg-primary px-7 py-2.5 text-sm font-bold text-white shadow-sm shadow-primary/30 transition-colors hover:bg-primary/90"
            >
              <Icon name="dashboard" className="text-lg" />
              Return to Dashboard
            </a>
          </div>
        </div>

        {referenceNumber ? (
          <div className="border-t border-slate-100 bg-slate-50/50 px-10 py-4 text-center">
            <p className="text-xs text-slate-400">Reference: {referenceNumber}</p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
