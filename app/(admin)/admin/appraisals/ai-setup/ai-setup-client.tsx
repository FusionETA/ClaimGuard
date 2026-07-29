"use client"

import { useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Icon } from "@/app/(employee)/employee/appraisals/_ui"
import {
  groupAiQuestionsBySection,
  renderChatMarkup,
  toTemplateQuestionInput,
  type AiChatMessage,
  type AiGeneratedTemplate,
} from "@/modules/appraisify/domain/models"

import { saveTemplateAction } from "../templates/actions"
import { aiSetupChatAction } from "./actions"

const TEMPLATE_LIMIT = 5

type ChatEntry = AiChatMessage & { templates?: AiGeneratedTemplate[] }
type GeneratedCard = { key: string; template: AiGeneratedTemplate; savedId: string | null }

const GREETING =
  "Hi! I'm your AI HR consultant. I'll help you build a complete suite of appraisal templates tailored to your company.\n\nLet's start with the basics — **what industry is your company in**, and roughly **how many people** do you have?"

export function AiSetupClient() {
  const [messages, setMessages] = useState<ChatEntry[]>([])
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const [cards, setCards] = useState<GeneratedCard[]>([])
  const [previewKey, setPreviewKey] = useState<string | null>(null)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const cardSeq = useRef(0)

  const hasUnsaved = cards.some((c) => !c.savedId)
  const atLimit = cards.length >= TEMPLATE_LIMIT

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (hasUnsaved) {
        e.preventDefault()
        e.returnValue = ""
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [hasUnsaved])

  async function send() {
    const text = input.trim()
    if (!text || sending || atLimit) return
    setInput("")

    const userEntry: ChatEntry = { role: "user", content: text }
    const nextMessages = [...messages, userEntry]
    setMessages(nextMessages)
    setSending(true)

    const res = await aiSetupChatAction({
      messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
      templatesGenerated: cards.length,
    })

    if (res.ok) {
      setMessages((p) => [...p, { role: "assistant", content: res.replyText, templates: res.templates }])
      if (res.templates.length) {
        setCards((p) => {
          const room = TEMPLATE_LIMIT - p.length
          const toAdd = res.templates.slice(0, Math.max(0, room))
          return [
            ...p,
            ...toAdd.map((template) => ({ key: `t${cardSeq.current++}`, template, savedId: null })),
          ]
        })
      }
    } else {
      setMessages((p) => [...p, { role: "assistant", content: `Sorry, something went wrong. ${res.message}` }])
    }
    setSending(false)
  }

  async function saveCard(card: GeneratedCard) {
    setSavingKey(card.key)
    const res = await saveTemplateAction({
      id: null,
      name: card.template.name,
      questions: card.template.questions.map(toTemplateQuestionInput),
    })
    setSavingKey(null)
    if (res.ok) {
      setCards((p) => p.map((c) => (c.key === card.key ? { ...c, savedId: res.id } : c)))
    } else {
      alert(res.message)
    }
  }

  const previewCard = cards.find((c) => c.key === previewKey) ?? null

  return (
    <div className="mx-auto flex h-[calc(100vh-4rem)] max-w-6xl flex-col px-4 py-6">
      <div className="mb-4 flex items-center justify-between gap-4">
        <a
          href="/admin/appraisals/templates"
          onClick={(e) => {
            if (hasUnsaved && !confirm("You have unsaved templates. Leave without saving them?")) {
              e.preventDefault()
            }
          }}
          className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-primary"
        >
          <Icon name="arrow_back" className="text-lg" />
          Question Sets
        </a>
        <span className="rounded-full bg-violet-100 px-2.5 py-0.5 text-xs font-bold text-violet-700">
          ✨ AI Template Setup
        </span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        {/* Chat column */}
        <Card className="flex min-h-0 flex-col overflow-hidden">
          <div className="border-b border-border/60 bg-gradient-to-r from-violet-50 to-card px-5 py-4">
            <h3 className="font-bold text-foreground">AI Consultant</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              I&apos;ll learn about your company and build a tailored appraisal template suite
            </p>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto p-5">
            <ChatBubble role="assistant" html={renderChatMarkup(GREETING)} />

            {messages.map((entry, idx) =>
              entry.role === "user" ? (
                <ChatBubble key={idx} role="user" html={renderChatMarkup(entry.content)} />
              ) : (
                <div key={idx} className="flex gap-2.5">
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
                    {entry.templates?.map((tpl, i) => (
                      <div key={i} className="rounded-xl border border-violet-200 bg-violet-50/50 p-3 text-xs">
                        <p className="font-bold text-foreground">{tpl.name}</p>
                        <p className="mt-0.5 text-muted-foreground">{tpl.questions.length} questions</p>
                        <p className="mt-1 text-[10px] text-violet-600">Saved to panel &rarr;</p>
                      </div>
                    ))}
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
                disabled={atLimit}
                rows={2}
                placeholder={atLimit ? "Template limit reached for this session." : "Describe your company or answer the AI's questions…"}
                className="flex-1 resize-none"
              />
              <Button
                onClick={send}
                disabled={sending || atLimit || !input.trim()}
                className="h-auto shrink-0 self-stretch bg-violet-600 hover:bg-violet-700"
              >
                <Icon name="send" className="text-lg" />
              </Button>
            </div>
            {atLimit ? (
              <div className="mt-2 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                <Icon name="block" className="text-sm" />
                Session limit reached (5 templates). Save your templates or start a new session.
              </div>
            ) : (
              <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
                AI may make mistakes — review each template before saving
              </p>
            )}
          </div>
        </Card>

        {/* Generated templates panel */}
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-foreground">Generated Templates</h3>
            <span
              className={
                atLimit
                  ? "rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700"
                  : "rounded-full bg-surface-low px-2 py-0.5 text-xs font-bold text-muted-foreground"
              }
            >
              {cards.length} / {TEMPLATE_LIMIT}
            </span>
          </div>

          {cards.length === 0 ? (
            <Card className="border-dashed p-4 text-center text-xs text-muted-foreground shadow-none">
              Templates will appear here as the AI generates them
            </Card>
          ) : (
            cards.map((card) => (
              <Card key={card.key} className={card.savedId ? "border-emerald-200 bg-emerald-50/30 p-4 shadow-none" : "p-4 shadow-none"}>
                <p className="text-sm font-bold text-foreground">{card.template.name}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">{card.template.questions.length} questions</p>
                <div className="mt-3 flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1" onClick={() => setPreviewKey(card.key)}>
                    Preview
                  </Button>
                  {card.savedId ? (
                    <div className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 py-1.5 text-xs font-bold text-emerald-700">
                      <Icon name="check_circle" className="text-sm" /> Saved
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      className="flex-1 bg-violet-600 hover:bg-violet-700"
                      disabled={savingKey === card.key}
                      onClick={() => saveCard(card)}
                    >
                      {savingKey === card.key ? "Saving…" : "Save"}
                    </Button>
                  )}
                </div>
              </Card>
            ))
          )}
        </div>
      </div>

      <Dialog open={previewCard !== null} onOpenChange={(open) => !open && setPreviewKey(null)}>
        <DialogContent className="flex max-h-[85vh] flex-col">
          <DialogHeader>
            <DialogTitle>{previewCard?.template.name ?? "Template Preview"}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 space-y-4 overflow-y-auto py-2">
            {previewCard
              ? groupAiQuestionsBySection(previewCard.template.questions).map(({ section, questions }) => (
                  <div key={section}>
                    <p className="mb-2 text-xs font-bold uppercase tracking-wider text-violet-600">{section}</p>
                    <div className="space-y-2">
                      {questions.map((q, i) => (
                        <div key={i} className="rounded-lg border border-border/70 bg-card px-3 py-2.5">
                          <p className="text-sm font-medium text-foreground">
                            {i + 1}. {q.text}
                          </p>
                          {q.desc ? <p className="mt-1 text-xs text-muted-foreground">{q.desc}</p> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              : null}
          </div>
          {previewCard && !previewCard.savedId ? (
            <Button
              className="bg-violet-600 hover:bg-violet-700"
              onClick={() => {
                const card = previewCard
                setPreviewKey(null)
                void saveCard(card)
              }}
            >
              Save Template
            </Button>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
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
      <p className="flex-1 text-sm leading-relaxed text-foreground" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
