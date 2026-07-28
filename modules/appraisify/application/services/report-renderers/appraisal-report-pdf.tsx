/**
 * Single-appraisal PDF report, rendered server-side via `@react-pdf/renderer`.
 * Styled after `components/admin/payroll-report-pdf-documents.tsx` (same
 * COLOURS/spacing language) but with the Appraisify brand blue in place of
 * the payroll purple, matching `.appraisify-scope`'s `--primary` remap.
 */

import {
  Document,
  Page,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer"

import {
  appraisalTypeLabel,
  averagePhaseScore,
  buildCycleLabel,
  phaseLabel,
  type AppraisalPhase,
  type AppraisalQuestionView,
  type AppraisalRecord,
  type AppraisalSectionText,
} from "@/modules/appraisify/domain/models"

const COLOURS = {
  ink: "#0f172a",
  muted: "#64748b",
  faint: "#94a3b8",
  divider: "#e2e8f0",
  rule: "#cbd5e1",
  panelBg: "#f8fafc",
}

// Appraisify brand blue — matches `.appraisify-scope`'s `--primary` remap.
const BRAND = "#136dec"

const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 40,
    paddingHorizontal: 40,
    fontSize: 9,
    color: COLOURS.ink,
    fontFamily: "Helvetica",
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  headerOrg: {
    fontSize: 13,
    fontFamily: "Helvetica-Bold",
    color: COLOURS.ink,
  },
  headerSub: {
    marginTop: 2,
    fontSize: 9.5,
    color: COLOURS.muted,
  },
  headerRight: { alignItems: "flex-end" },
  referenceTag: {
    fontSize: 8.5,
    fontFamily: "Helvetica-Bold",
    color: BRAND,
  },
  brandRule: {
    height: 2,
    backgroundColor: BRAND,
    marginTop: 6,
    marginBottom: 14,
  },
  // ─── Identity + score summary ─────────────────────────────────────
  identityRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 16,
  },
  revieweeName: {
    fontSize: 15,
    fontFamily: "Helvetica-Bold",
  },
  revieweeMeta: {
    marginTop: 2,
    fontSize: 9,
    color: COLOURS.muted,
  },
  scoreGrid: { flexDirection: "row", gap: 10 },
  scoreTile: {
    width: 84,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: COLOURS.panelBg,
    borderLeftWidth: 3,
    borderLeftColor: BRAND,
  },
  scoreTileLabel: {
    fontSize: 7,
    color: COLOURS.muted,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  scoreTileValue: {
    marginTop: 2,
    fontSize: 16,
    fontFamily: "Helvetica-Bold",
    color: COLOURS.ink,
  },
  // ─── Section / question table ─────────────────────────────────────
  sectionTitle: {
    marginTop: 16,
    marginBottom: 6,
    fontSize: 10.5,
    fontFamily: "Helvetica-Bold",
    color: BRAND,
  },
  questionHeaderRow: {
    flexDirection: "row",
    paddingBottom: 3,
    borderBottomWidth: 0.75,
    borderBottomColor: COLOURS.rule,
  },
  questionHeaderLabel: {
    flex: 4,
    fontSize: 7.5,
    fontFamily: "Helvetica-Bold",
    color: COLOURS.muted,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  questionHeaderScore: {
    width: 62,
    textAlign: "center",
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    color: COLOURS.muted,
    textTransform: "uppercase",
    letterSpacing: 0.2,
  },
  questionRow: {
    flexDirection: "row",
    paddingVertical: 5,
    borderBottomWidth: 0.5,
    borderBottomColor: COLOURS.divider,
  },
  questionText: { flex: 4, fontSize: 9 },
  questionScore: {
    width: 62,
    textAlign: "center",
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
  },
  // ─── Free-text phase blocks ────────────────────────────────────────
  textBlock: {
    marginTop: 10,
    padding: 10,
    backgroundColor: COLOURS.panelBg,
  },
  textBlockTitle: {
    fontSize: 8.5,
    fontFamily: "Helvetica-Bold",
    color: BRAND,
    marginBottom: 5,
  },
  textBlockField: { marginBottom: 5 },
  textBlockFieldLabel: {
    fontSize: 7.5,
    color: COLOURS.muted,
    textTransform: "uppercase",
    letterSpacing: 0.3,
    marginBottom: 1,
  },
  textBlockFieldValue: { fontSize: 9, lineHeight: 1.4 },
  emptyNote: { fontSize: 8.5, color: COLOURS.faint, fontFamily: "Helvetica-Oblique" },
  footer: {
    position: "absolute",
    bottom: 18,
    left: 40,
    right: 40,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7.5,
    color: COLOURS.faint,
  },
})

function fmtScore(n: number | null): string {
  return n == null ? "—" : n.toFixed(2)
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

function scoreForPhase(q: AppraisalQuestionView, phase: AppraisalPhase): number | null {
  switch (phase) {
    case "reviewee":
      return q.revieweeScore
    case "reviewer":
      return q.reviewerScore
    case "partner":
      return q.partnerScore
  }
}

/** Group questions by section, preserving first-seen order (no section → "General"). */
function groupBySection(
  questions: AppraisalQuestionView[],
): Array<{ section: string; questions: AppraisalQuestionView[] }> {
  const order: string[] = []
  const bySection = new Map<string, AppraisalQuestionView[]>()
  for (const q of questions) {
    const key = q.section ?? "General"
    if (!bySection.has(key)) {
      order.push(key)
      bySection.set(key, [])
    }
    bySection.get(key)!.push(q)
  }
  return order.map((section) => ({ section, questions: bySection.get(section)! }))
}

export type AppraisalReportPdfDocumentProps = {
  organizationName: string
  record: AppraisalRecord
  generatedAt: Date
}

export function AppraisalReportPdfDocument({
  organizationName,
  record,
  generatedAt,
}: AppraisalReportPdfDocumentProps) {
  const cycleLabel = buildCycleLabel(record.type, record.year)
  const sections = groupBySection(record.questions)
  const selfScore = averagePhaseScore(record.questions, "reviewee")
  const reviewerScore = averagePhaseScore(record.questions, "reviewer")
  const partnerScore = averagePhaseScore(record.questions, "partner")

  return (
    <Document
      title={`Appraisal Report ${record.referenceNumber}`}
      author={organizationName}
    >
      <Page size="A4" style={styles.page}>
        {/* ── Header ──────────────────────────────────────────────── */}
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.headerOrg}>{organizationName}</Text>
            <Text style={styles.headerSub}>Performance Appraisal Report</Text>
          </View>
          <View style={styles.headerRight}>
            <Text style={styles.referenceTag}>{record.referenceNumber}</Text>
            <Text style={styles.headerSub}>{cycleLabel}</Text>
          </View>
        </View>
        <View style={styles.brandRule} />

        {/* ── Reviewee identity + score summary ──────────────────── */}
        <View style={styles.identityRow}>
          <View>
            <Text style={styles.revieweeName}>{record.reviewee.name}</Text>
            <Text style={styles.revieweeMeta}>
              {[record.role, record.team].filter(Boolean).join(" · ") || "—"}
            </Text>
            <Text style={styles.revieweeMeta}>
              {appraisalTypeLabel(record.type)} · {record.year}
            </Text>
          </View>
          <View style={styles.scoreGrid}>
            <ScoreTile label="Self" score={selfScore} />
            <ScoreTile label={phaseLabel("reviewer")} score={reviewerScore} />
            <ScoreTile label={phaseLabel("partner")} score={partnerScore} />
          </View>
        </View>

        {/* ── Questions, grouped by section ──────────────────────── */}
        {sections.map(({ section, questions }) => (
          <View key={section} wrap={false}>
            <Text style={styles.sectionTitle}>{section}</Text>
            <View style={styles.questionHeaderRow}>
              <Text style={styles.questionHeaderLabel}>Question</Text>
              <Text style={styles.questionHeaderScore}>Self</Text>
              <Text style={styles.questionHeaderScore}>{phaseLabel("reviewer")}</Text>
              <Text style={styles.questionHeaderScore}>{phaseLabel("partner")}</Text>
            </View>
            {questions.map((q) => (
              <View key={q.id} style={styles.questionRow}>
                <Text style={styles.questionText}>{q.text}</Text>
                <Text style={styles.questionScore}>
                  {fmtScore(scoreForPhase(q, "reviewee"))}
                </Text>
                <Text style={styles.questionScore}>
                  {fmtScore(scoreForPhase(q, "reviewer"))}
                </Text>
                <Text style={styles.questionScore}>
                  {fmtScore(scoreForPhase(q, "partner"))}
                </Text>
              </View>
            ))}
          </View>
        ))}

        {/* ── Free-text phase blocks ──────────────────────────────── */}
        <PhaseTextBlock title="Self-Assessment" section={record.revieweeSection} />
        <PhaseTextBlock title={phaseLabel("reviewer")} section={record.reviewerSection} />
        <PhaseTextBlock title={phaseLabel("partner")} section={record.partnerSection} />

        <View style={styles.footer} fixed>
          <Text>
            {organizationName} · Generated {fmtDate(generatedAt)}
          </Text>
          <Text
            render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  )
}

function ScoreTile({ label, score }: { label: string; score: number | null }) {
  return (
    <View style={styles.scoreTile}>
      <Text style={styles.scoreTileLabel}>{label}</Text>
      <Text style={styles.scoreTileValue}>{fmtScore(score)}</Text>
    </View>
  )
}

function PhaseTextBlock({
  title,
  section,
}: {
  title: string
  section: AppraisalSectionText
}) {
  const fields: Array<{ label: string; value: string | null }> = [
    { label: "Goals Review", value: section.goals },
    { label: "Overall Remarks", value: section.remarks },
    { label: "Development Plans", value: section.development },
  ]
  const hasAny = fields.some((f) => f.value)

  return (
    <View style={styles.textBlock} wrap={false}>
      <Text style={styles.textBlockTitle}>{title}</Text>
      {hasAny ? (
        fields.map((f) =>
          f.value ? (
            <View key={f.label} style={styles.textBlockField}>
              <Text style={styles.textBlockFieldLabel}>{f.label}</Text>
              <Text style={styles.textBlockFieldValue}>{f.value}</Text>
            </View>
          ) : null,
        )
      ) : (
        <Text style={styles.emptyNote}>Not submitted.</Text>
      )}
    </View>
  )
}

export async function renderAppraisalReportPdf(
  props: AppraisalReportPdfDocumentProps,
): Promise<Buffer> {
  const { renderToBuffer } = await import("@react-pdf/renderer")
  return renderToBuffer(<AppraisalReportPdfDocument {...props} />)
}
