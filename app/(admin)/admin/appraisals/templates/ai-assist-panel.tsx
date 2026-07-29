"use client"

import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { Icon } from "@/app/(employee)/employee/appraisals/_ui"
import { renderChatMarkup, type AiChatMessage, type AiSuggestedQuestion } from "@/modules/appraisify/domain/models"

import { aiAssistChatAction } from "./actions"

type ChatEntry = AiChatMessage & { questions?: AiSuggestedQuestion[] }

export function AiAssistPanel({
  open,
  onOpenChange,
  templateName,
  existingSections,
  onAddQuestion,
  onAddAll,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  templateName: string
  existingSections: string[]
  onAddQuestion: (q: AiSuggestedQuestion) => void
  onAddAll: (qs: AiSuggestedQuestion[]) => void
}) {
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set())

  const greeting = `Hi! I'll help you build great appraisal questions${
    templateName ? ` for **${templateName}**` : ""
  }. Describe a theme (e.g. "leadership and communication") or ask me to generate a full set.`

  async function send() {
    const text = input.trim()
    if (!text || sending) return
    setInput("")

    const userEntry: ChatEntry = { role: "user", content: text }
    const nextEntries = [...entries, userEntry]
    setEntries(nextEntries)
    setSending(true)

    const res = await aiAssistChatAction({
      messages: nextEntries.map((e) => ({ role: e.role, content: e.content })),
      templateName: templateName || null,
      existingSections,
    })

    if (res.ok) {
      setEntries((p) => [...p, { role: "assistant", content: res.replyText, questions: res.questions }])
    } else {
      setEntries((p) => [...p, { role: "assistant", content: `Sorry, I couldn't process that. ${res.message}` }])
    }
    setSending(false)
  }

  function addQuestion(entryIdx: number, qIdx: number, q: AiSuggestedQuestion) {
    onAddQuestion(q)
    setAddedKeys((p) => new Set(p).add(`${entryIdx}:${qIdx}`))
  }

  function addAll(entryIdx: number, qs: AiSuggestedQuestion[]) {
    onAddAll(qs)
    setAddedKeys((p) => {
      const next = new Set(p)
      qs.forEach((_, i) => next.add(`${entryIdx}:${i}`))
      return next
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col p-0">
        <SheetHeader className="border-b border-border/60 bg-gradient-to-r from-violet-50 to-card px-5 py-4">
          <SheetTitle className="flex items-center gap-1.5 text-base">
            <span aria-hidden>✨</span> AI Question Assistant
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <ChatBubble role="assistant" html={renderChatMarkup(greeting)} />

          {entries.map((entry, entryIdx) =>
            entry.role === "user" ? (
              <ChatBubble key={entryIdx} role="user" html={renderChatMarkup(entry.content)} />
            ) : (
              <div key={entryIdx} className="flex gap-2.5">
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-100 text-sm">
                  ✨
                </div>
                <div className="flex-1 space-y-2">
                  {entry.content ? (
                    <p
                      className="text-sm leading-relaxed text-foreground"
                      dangerouslySetInnerHTML={{ __html: renderChatMarkup(entry.content) }}
                    />
                  ) : null}
                  {entry.questions?.length ? (
                    <div className="space-y-2">
                      {entry.questions.map((q, qIdx) => (
                        <QuestionCard
                          key={qIdx}
                          question={q}
                          added={addedKeys.has(`${entryIdx}:${qIdx}`)}
                          onAdd={() => addQuestion(entryIdx, qIdx, q)}
                        />
                      ))}
                      {entry.questions.length > 1 ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full border-violet-300 text-violet-700 hover:bg-violet-50"
                          onClick={() => addAll(entryIdx, entry.questions!)}
                        >
                          + Add All {entry.questions.length} Questions
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            ),
          )}

          {sending ? (
            <div className="flex gap-2.5">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-100 text-sm">✨</div>
              <div className="animate-pulse rounded-2xl bg-surface-low px-4 py-2.5 text-sm text-muted-foreground">
                Thinking…
              </div>
            </div>
          ) : null}
        </div>

        <div className="border-t border-border/60 bg-surface-low/50 px-4 py-3">
          <div className="flex gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              rows={2}
              placeholder="Ask me to generate questions…"
              className="flex-1 resize-none"
            />
            <Button
              onClick={send}
              disabled={sending || !input.trim()}
              className="h-auto shrink-0 self-stretch bg-violet-600 hover:bg-violet-700"
            >
              <Icon name="send" className="text-lg" />
            </Button>
          </div>
          <p className="mt-1.5 text-center text-[10px] text-muted-foreground">Powered by AI &mdash; review suggestions before adding.</p>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ChatBubble({ role, html }: { role: "user" | "assistant"; html: string }) {
  if (role === "user") {
    return (
      <div className="flex justify-end">
        <div
          className="max-w-[85%] rounded-2xl rounded-tr-sm bg-violet-600 px-4 py-2.5 text-sm text-white"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    )
  }
  return (
    <div className="flex gap-2.5">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-100 text-sm">✨</div>
      <p
        className="flex-1 text-sm leading-relaxed text-foreground"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}

function QuestionCard({
  question,
  added,
  onAdd,
}: {
  question: AiSuggestedQuestion
  added: boolean
  onAdd: () => void
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-surface-low/80 p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {question.section ? (
            <span className="text-[10px] font-bold uppercase tracking-wider text-violet-600">
              {question.section}
            </span>
          ) : null}
          <p className="mt-0.5 text-xs font-medium text-foreground">{question.text}</p>
          {question.desc ? <p className="mt-1 text-[11px] text-muted-foreground">{question.desc}</p> : null}
        </div>
        <button
          onClick={onAdd}
          disabled={added}
          title={added ? "Added" : "Add to list"}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
            added
              ? "bg-emerald-500 text-white"
              : "bg-violet-600 text-white hover:bg-violet-700",
          )}
        >
          <Icon name={added ? "check" : "add"} className="text-sm" />
        </button>
      </div>
    </div>
  )
}
