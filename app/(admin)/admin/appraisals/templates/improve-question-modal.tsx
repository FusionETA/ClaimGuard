"use client"

import { useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Icon } from "@/app/(employee)/employee/appraisals/_ui"
import { renderChatMarkup, type AiChatMessage, type AiSuggestedQuestion } from "@/modules/appraisify/domain/models"

import { aiImproveQuestionAction } from "./actions"

type ImprovableQuestion = { section: string; text: string; description: string }

function buildSeedMessage(question: ImprovableQuestion): string {
  const lines = ["I have an appraisal question I'd like to improve:", "", `**Question:** ${question.text}`]
  if (question.description) lines.push(`**Guidance:** ${question.description}`)
  if (question.section) lines.push(`**Section:** ${question.section}`)
  lines.push("", "Can you suggest an improved version?")
  return lines.join("\n")
}

export function ImproveQuestionModal({
  question,
  open,
  onOpenChange,
  onUseVersion,
}: {
  question: ImprovableQuestion | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onUseVersion: (q: AiSuggestedQuestion) => void
}) {
  const [messages, setMessages] = useState<AiChatMessage[]>([])
  const [suggestion, setSuggestion] = useState<AiSuggestedQuestion | null>(null)
  const [replyText, setReplyText] = useState("")
  const [sending, setSending] = useState(false)
  const [input, setInput] = useState("")
  const seededForKey = useRef<string | null>(null)

  useEffect(() => {
    if (!open || !question) return
    const seedKey = `${question.section}|${question.text}`
    if (seededForKey.current === seedKey) return
    seededForKey.current = seedKey

    setMessages([])
    setSuggestion(null)
    setReplyText("")
    const seed: AiChatMessage = { role: "user", content: buildSeedMessage(question) }
    setMessages([seed])
    void callImprove([seed])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, question])

  async function callImprove(history: AiChatMessage[]) {
    setSending(true)
    const res = await aiImproveQuestionAction({ messages: history })
    if (res.ok) {
      setReplyText(res.replyText)
      setSuggestion(res.questions[0] ?? null)
      setMessages((p) => [...p, { role: "assistant", content: res.replyText }])
    } else {
      setReplyText(`Sorry, something went wrong. ${res.message}`)
    }
    setSending(false)
  }

  function send() {
    const text = input.trim()
    if (!text || sending) return
    setInput("")
    const next = [...messages, { role: "user" as const, content: text }]
    setMessages(next)
    void callImprove(next)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) seededForKey.current = null
        onOpenChange(next)
      }}
    >
      <DialogContent className="flex max-h-[80vh] flex-col p-0">
        <DialogHeader className="border-b border-border/60 px-5 py-4">
          <DialogTitle className="flex items-center gap-1.5 text-base">
            <span aria-hidden>✨</span> Improve Question
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {sending && !replyText ? (
            <div className="flex gap-2.5">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-100 text-sm">✨</div>
              <div className="animate-pulse rounded-2xl bg-surface-low px-4 py-2.5 text-sm text-muted-foreground">
                Thinking…
              </div>
            </div>
          ) : null}

          {replyText ? (
            <div className="flex gap-2.5">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-100 text-sm">
                ✨
              </div>
              <p
                className="flex-1 text-sm leading-relaxed text-foreground"
                dangerouslySetInnerHTML={{ __html: renderChatMarkup(replyText) }}
              />
            </div>
          ) : null}

          {suggestion ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3">
              {suggestion.section ? (
                <span className="text-[10px] font-bold uppercase text-emerald-700">{suggestion.section}</span>
              ) : null}
              <p className="mt-0.5 text-xs font-medium text-foreground">{suggestion.text}</p>
              {suggestion.desc ? <p className="mt-1 text-[11px] text-muted-foreground">{suggestion.desc}</p> : null}
              <Button
                size="sm"
                className="mt-2 w-full bg-emerald-600 hover:bg-emerald-700"
                onClick={() => onUseVersion(suggestion)}
              >
                <Icon name="check" className="text-sm" /> Use This Version
              </Button>
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
              placeholder="e.g. 'Make it more specific' or 'Rewrite for a manager'"
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
        </div>
      </DialogContent>
    </Dialog>
  )
}
