'use client'

import { useState, useRef, useEffect, useEffectEvent, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { apiFetch } from '@/lib/api'
import { useAuthStore } from '@/store/auth'
import { useLanguageStore } from '@/store/language'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { AudioPlayer } from '@/components/ui/AudioPlayer'
import { MaintenanceGate } from '@/components/billing/MaintenanceBanner'
import { PaywallBanner } from '@/components/billing/PaywallBanner'
import { FreemiumQuotaBanner } from '@/components/billing/FreemiumQuotaBanner'
import { useFreemiumStore } from '@/store/freemium'
import { useConfigStore } from '@/store/config'
import { isSubscribed, isFreemiumTrialActive } from '@/store/auth'
import { WordTooltip, useWordSave } from '@/components/ui/WordTooltip'
import { PageLoading } from '@/components/ui/page-loading'
import { TargetLanguageText } from '@/components/TargetLanguageText'
import { ChatMarkdown } from '@/components/chat/ChatMarkdown'
import { AuthAvatarImage } from '@/components/AuthAvatarImage'
import { MemorySavedToast } from '@/components/memory/MemorySavedToast'
import { useTransientToast } from '@/hooks/useTransientToast'
import { readSseData } from '@/lib/sse'
import LinguAvatar from '@/components/lingu/LinguAvatar'
import { LinguistLogoMark } from '@/components/ui/LinguistLogoMark'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface Conversation {
  id: number
  title: string
  source: string
  created_at: string
  updated_at: string
}

interface ChatSseEvent {
  conversation_id?: number
  token?: string
  response_reset?: boolean
  error?: string
  done?: boolean
  memory_updated?: boolean
}

export default function ChatPage() {
  const sessionVersion = useAuthStore((s) => s.sessionVersion)
  const languageCode = useLanguageStore((s) => s.activeLanguage?.code)
  return <ChatContent key={`${sessionVersion}:${languageCode ?? 'en-GB'}`} />
}

function ChatContent() {
  const t = useTranslations('chat')
  const tCommon = useTranslations('common')
  const tLang = useTranslations('targetLanguages')
  const tQuota = useTranslations('conversation')
  const router = useRouter()
  const user = useAuthStore((s) => s.user)
  const sessionVersion = useAuthStore((s) => s.sessionVersion)
  const activeLanguage = useLanguageStore((s) => s.activeLanguage)
  const {
    selectedWord,
    tooltipPos,
    saveState,
    handleTextSelection,
    handleSaveWord,
    dismissTooltip,
  } = useWordSave()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [sendingWarn, setSendingWarn] = useState(false)
  const sendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [error, setError] = useState('')
  const [loadingConvs, setLoadingConvs] = useState(true)
  const [convLoadError, setConvLoadError] = useState(false)
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [msgLoadError, setMsgLoadError] = useState(false)
  const [awaitingInitialSelection, setAwaitingInitialSelection] = useState(true)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const mounted = useRef(false)
  const listController = useRef<AbortController | null>(null)
  const messageController = useRef<AbortController | null>(null)
  const streamController = useRef<AbortController | null>(null)
  const deleteController = useRef<AbortController | null>(null)
  const selectionVersion = useRef(0)
  const selectedId = useRef<number | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [deletePending, setDeletePending] = useState<number | null>(null)
  const {
    visible: memoryToast,
    announcementId: memoryToastId,
    show: showMemoryToast,
  } = useTransientToast()
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const targetLanguageCode = activeLanguage?.code ?? 'en-GB'

  const stripeEnabled = useConfigStore((s) => s.stripeEnabled)
  const freemiumStatus = useFreemiumStore((s) => s.status)
  const fetchFreemium = useFreemiumStore((s) => s.fetchStatus)
  const decrementFreemium = useFreemiumStore((s) => s.decrement)
  const freemiumExhausted =
    stripeEnabled &&
    !isSubscribed(user, stripeEnabled) &&
    !isFreemiumTrialActive(user, stripeEnabled) &&
    freemiumStatus &&
    freemiumStatus.chat_remaining <= 0

  useEffect(() => {
    if (stripeEnabled && !isSubscribed(user, stripeEnabled)) {
      fetchFreemium()
    }
  }, [stripeEnabled, user, fetchFreemium])

  const scrollBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollBottom()
  }, [messages, scrollBottom])

  // Open sidebar by default only on desktop
  useEffect(() => {
    setSidebarOpen(window.innerWidth >= 768)
  }, [])

  // Warn if LLM takes longer than 60 s
  useEffect(() => {
    if (sending) {
      setSendingWarn(false)
      sendingTimerRef.current = setTimeout(() => setSendingWarn(true), 60_000)
    } else {
      if (sendingTimerRef.current) clearTimeout(sendingTimerRef.current)
      setSendingWarn(false)
    }
    return () => {
      if (sendingTimerRef.current) clearTimeout(sendingTimerRef.current)
    }
  }, [sending])

  async function loadConversations(autoSelect = false) {
    listController.current?.abort()
    const controller = new AbortController()
    listController.current = controller
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(20_000),
    ])
    const selection = selectionVersion.current
    setLoadingConvs(true)
    setConvLoadError(false)
    try {
      const res = await apiFetch('/api/chat/conversations', { signal })
      if (!res.ok) throw new Error()
      const data: Conversation[] = await res.json()
      signal.throwIfAborted()
      if (listController.current !== controller) return null
      setConversations(data)
      if (autoSelect && selectionVersion.current === selection) {
        setAwaitingInitialSelection(false)
        if (data.length > 0) void selectConversation(data[0].id)
      }
      return data
    } catch {
      if (listController.current === controller) setConvLoadError(true)
      return null
    } finally {
      if (listController.current === controller) setLoadingConvs(false)
    }
  }

  const initialize = useEffectEvent(() => {
    void loadConversations(true)
  })
  useEffect(() => {
    mounted.current = true
    initialize()
    return () => {
      mounted.current = false
      listController.current?.abort()
      listController.current = null
      messageController.current?.abort()
      messageController.current = null
      streamController.current?.abort()
      streamController.current = null
      deleteController.current?.abort()
      deleteController.current = null
    }
  }, [])

  async function selectConversation(id: number) {
    if (streamController.current || deletingId === id) return
    ++selectionVersion.current
    messageController.current?.abort()
    const controller = new AbortController()
    messageController.current = controller
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(20_000),
    ])
    dismissTooltip()
    if (window.innerWidth < 768) setSidebarOpen(false)
    setActiveId(id)
    selectedId.current = id
    setAwaitingInitialSelection(false)
    setMessages([])
    setError('')
    setMsgLoadError(false)
    setLoadingMsgs(true)
    try {
      const res = await apiFetch(`/api/chat/conversations/${id}/messages`, {
        signal,
      })
      if (!res.ok) throw new Error()
      const data = await res.json()
      signal.throwIfAborted()
      if (messageController.current !== controller) return
      setMessages(data.messages || [])
    } catch {
      if (messageController.current === controller) setMsgLoadError(true)
    } finally {
      if (messageController.current === controller) setLoadingMsgs(false)
    }
  }

  function newChat() {
    if (streamController.current) return
    ++selectionVersion.current
    messageController.current?.abort()
    messageController.current = null
    // Don't create — let the first message auto-create the conversation
    dismissTooltip()
    setActiveId(null)
    selectedId.current = null
    setAwaitingInitialSelection(false)
    setLoadingMsgs(false)
    setMsgLoadError(false)
    setMessages([])
    setError('')
    if (window.innerWidth < 768) setSidebarOpen(false)
    requestAnimationFrame(() => {
      if (mounted.current) inputRef.current?.focus()
    })
  }

  function continueInVoice() {
    const context = messages
      .filter((m) => m.content.trim().length > 0)
      .slice(-20)
    // Only pass the message context — no conversation_id.
    // The voice session will create its own new conversation record so the
    // original text chat stays clean and the two appear as separate entries
    // in the sidebar (the voice one gets the 🎤 icon).
    sessionStorage.setItem(
      'voice_context',
      JSON.stringify({
        messages: context,
      })
    )
    router.push('/conversation')
  }

  async function deleteConversation(id: number) {
    if (deleteController.current || streamController.current) return
    const controller = new AbortController()
    deleteController.current = controller
    setDeletingId(id)
    setError('')
    // Invalidate list snapshots that may still include the deleted conversation.
    listController.current?.abort()
    listController.current = null
    setLoadingConvs(false)
    if (selectedId.current === id) {
      messageController.current?.abort()
      messageController.current = null
      setLoadingMsgs(false)
    }
    const selection = ++selectionVersion.current
    try {
      const res = await apiFetch(`/api/chat/conversations/${id}`, {
        method: 'DELETE',
        signal: controller.signal,
      })
      if (!res.ok) throw new Error()
      if (deleteController.current !== controller) return
      setDeletePending(null)
      setConversations((prev) => prev.filter((item) => item.id !== id))
      const replaceActive =
        selectionVersion.current === selection && selectedId.current === id
      if (replaceActive) {
        newChat()
      }
      const replacementSelection = selectionVersion.current
      const updated = await loadConversations()
      if (deleteController.current !== controller) return
      if (
        replaceActive &&
        updated &&
        selectionVersion.current === replacementSelection &&
        updated.length > 0
      ) {
        void selectConversation(updated[0].id)
      }
    } catch {
      if (
        deleteController.current === controller &&
        selectionVersion.current === selection
      ) {
        setError(tCommon('error'))
        if (selectedId.current === id) setMsgLoadError(true)
      }
    } finally {
      if (deleteController.current === controller) {
        deleteController.current = null
        setDeletingId(null)
      }
    }
  }

  const historyPending =
    loadingMsgs ||
    (loadingConvs && awaitingInitialSelection) ||
    (deletingId !== null && deletingId === activeId)
  const historyFailed =
    msgLoadError || (convLoadError && awaitingInitialSelection)
  const historyUnavailable =
    loadingMsgs ||
    msgLoadError ||
    awaitingInitialSelection ||
    deletingId !== null

  async function sendMessage() {
    if (!input.trim() || streamController.current || historyUnavailable) return
    const controller = new AbortController()
    streamController.current = controller
    ++selectionVersion.current
    const text = input.trim()
    setInput('')
    setError('')
    setMessages((prev) => [...prev, { role: 'user', content: text }])
    setSending(true)

    try {
      const res = await apiFetch('/api/chat', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, conversation_id: activeId }),
      })
      if (streamController.current !== controller) return

      if (!res.ok) {
        let message = t('errorMessage')
        if (res.status === 429) {
          const data = await res.json().catch(() => ({}))
          if (streamController.current !== controller) return
          if (
            typeof data.detail === 'string' &&
            data.detail.startsWith('Monthly token limit reached')
          ) {
            message = tQuota('quotaExceededTokens')
          }
        }
        setError(message)
        return
      }

      let assistantContent = ''
      let streamCompleted = false
      setMessages((prev) => [...prev, { role: 'assistant', content: '' }])

      if (!res.body) throw new Error(t('errorMessage'))
      for await (const data of readSseData<ChatSseEvent>(res.body)) {
        if (streamController.current !== controller) return
        if (data.conversation_id && !activeId) {
          setActiveId(data.conversation_id)
          selectedId.current = data.conversation_id
          void loadConversations()
        }
        if (data.response_reset) {
          dismissTooltip()
          assistantContent = ''
          setMessages((prev) => {
            const copy = [...prev]
            copy[copy.length - 1] = { role: 'assistant', content: '' }
            return copy
          })
        }
        if (data.token) {
          assistantContent += data.token
          setMessages((prev) => {
            const copy = [...prev]
            copy[copy.length - 1] = {
              role: 'assistant',
              content: assistantContent,
            }
            return copy
          })
        }
        if (data.error) {
          streamCompleted = true
          setError(t('errorMessage'))
        }
        if (data.done) {
          streamCompleted = true
          if (
            !isSubscribed(user, stripeEnabled) &&
            !isFreemiumTrialActive(user, stripeEnabled) &&
            useAuthStore.getState().sessionVersion === sessionVersion
          ) {
            decrementFreemium('chat_remaining')
          }
          void loadConversations()
        }
        if (data.memory_updated) showMemoryToast()
      }
      if (!streamCompleted) throw new Error(t('errorMessage'))
    } catch {
      if (streamController.current === controller) setError(t('errorMessage'))
    } finally {
      if (streamController.current === controller) {
        streamController.current = null
        setSending(false)
        inputRef.current?.focus()
      }
    }
  }

  return (
    <MaintenanceGate>
      <div className="flex h-[calc(100dvh-56px)] w-full overflow-hidden md:h-screen">
        <MemorySavedToast
          visible={memoryToast}
          announcementId={memoryToastId}
        />
        {/* Sidebar backdrop — mobile only */}
        {sidebarOpen && (
          <div
            className="fixed inset-x-0 top-14 bottom-0 z-10 bg-black/40 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar */}
        {sidebarOpen && (
          <aside className="glass-panel border-fl-border/60 fixed top-14 bottom-0 left-0 z-20 flex w-56 shrink-0 flex-col overflow-hidden border-r md:relative md:top-auto md:bottom-auto md:left-auto md:z-auto">
            <div className="border-fl-border/60 flex items-center justify-between border-b px-4 py-3">
              <span className="text-fl-hint text-fl-muted-2 font-mono font-bold tracking-widest uppercase">
                {t('conversations')}
              </span>
              <button
                onClick={newChat}
                disabled={sending}
                className="neu-button text-fl-label text-fl-fg rounded-lg px-2.5 py-1 font-mono font-bold tracking-widest uppercase"
                title={t('newConversation')}
              >
                + {t('newConversation')}
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {loadingConvs && (
                <PageLoading fullScreen={false} className="block px-4 py-4" />
              )}
              {convLoadError && (
                <div className="flex flex-col items-center gap-3 px-4 py-6">
                  <p className="text-fl-error font-mono text-xs font-semibold">
                    {tCommon('error')}
                  </p>
                  <button
                    onClick={() => loadConversations(awaitingInitialSelection)}
                    disabled={loadingConvs}
                    className="neu-button text-fl-label text-fl-fg rounded-xl px-4 py-2 font-mono font-bold tracking-widest uppercase"
                  >
                    {tCommon('retry')}
                  </button>
                </div>
              )}
              {conversations.length === 0
                ? !loadingConvs &&
                !convLoadError && (
                  <p className="text-fl-label text-fl-muted-3 px-4 py-4 font-mono font-medium">
                    {t('noConversation')}
                  </p>
                )
                : conversations.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => selectConversation(c.id)}
                    className={`group mx-2 my-1 flex cursor-pointer items-center justify-between rounded-xl px-3 py-2.5 transition-all ${activeId === c.id
                        ? 'glass-card border-l-fl-accent border-l-2'
                        : 'hover:bg-fl-surface-2/60 border-l-2 border-l-transparent'
                      }`}
                  >
                    <span
                      className={`text-fl-label truncate pr-1 font-mono leading-tight ${activeId === c.id ? 'text-fl-fg' : 'text-fl-muted-1'}`}
                    >
                      {c.source === 'voice' && (
                        <span
                          className="text-fl-muted-3 mr-1.5"
                          title={t('voiceSession')}
                        >
                          🎤
                        </span>
                      )}
                      {c.title}
                    </span>
                    <button
                      disabled={sending || deletingId !== null}
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeletePending(c.id)
                      }}
                      className="text-fl-label text-fl-error-fg hover:text-fl-error shrink-0 font-mono opacity-0 transition-all group-hover:opacity-100"
                      title={t('deleteConfirm')}
                      aria-label={t('deleteConfirm')}
                    >
                      ✕
                    </button>
                  </div>
                ))}
            </div>
          </aside>
        )}

        {/* Main chat area */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Header */}
          <div className="glass-panel border-fl-border/60 flex shrink-0 items-center gap-2 border-b px-5 py-4">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="neu-button text-fl-label text-fl-fg mr-1 flex h-9 w-9 items-center justify-center rounded-xl text-base"
              title={
                sidebarOpen ? t('toggleSidebarHide') : t('toggleSidebarShow')
              }
            >
              {sidebarOpen ? '◀' : '☰'}
            </button>
            <LinguAvatar
              animation={sending ? 'pensando' : 'reposo'}
              className="!mx-0 h-[55px] w-[55px] shrink-0"
            />
            <span className="text-fl-label text-fl-muted-1 min-w-0 flex-1 truncate font-mono font-bold tracking-widest uppercase">
              {activeId
                ? (conversations.find((c) => c.id === activeId)?.title ??
                  t('title'))
                : t('newConversation')}
            </span>
            {sending ? (
              <div className="ml-auto flex shrink-0 flex-col items-end gap-0.5">
                <span className="text-fl-hint text-fl-muted-2 animate-pulse font-mono font-bold tracking-widest uppercase">
                  {t('thinking')}
                </span>
                {sendingWarn && (
                  <span className="text-fl-hint font-mono font-bold tracking-widest text-amber-500 uppercase">
                    {t('takingLonger')}
                  </span>
                )}
              </div>
            ) : messages.length > 0 && !historyUnavailable ? (
              <button
                onClick={continueInVoice}
                className="neu-button text-fl-hint text-fl-fg ml-auto rounded-xl px-3.5 py-2 font-mono font-bold tracking-widest uppercase"
              >
                {t('continueInVoice')}
              </button>
            ) : null}
          </div>

          <FreemiumQuotaBanner feature="chat" />

          {/* Messages */}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
            {historyPending ? (
              <div className="flex h-full items-center justify-center">
                <PageLoading fullScreen={false} />
              </div>
            ) : historyFailed ? (
              <div
                role="alert"
                className="flex h-full flex-col items-center justify-center gap-3"
              >
                <p className="text-fl-error font-mono text-xs font-semibold">
                  {tCommon('error')}
                </p>
                <button
                  onClick={() =>
                    activeId !== null
                      ? selectConversation(activeId)
                      : loadConversations(true)
                  }
                  className="neu-button text-fl-fg rounded-xl px-4 py-2 font-mono text-xs font-bold"
                >
                  {tCommon('retry')}
                </button>
              </div>
            ) : messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <div className="neu-glass-card max-w-sm rounded-3xl px-8 py-6">
                  <p className="text-fl-label text-fl-accent font-mono font-bold tracking-widest uppercase">
                    {t('title')}
                  </p>
                  <p className="text-fl-muted-1 mt-2 font-mono text-xs leading-relaxed font-medium">
                    {t('subtitle', {
                      language: activeLanguage
                        ? tLang(activeLanguage.code)
                        : tLang('en-GB'),
                    })}
                  </p>
                </div>
              </div>
            ) : (
              messages.map((msg, i) => (
                <div
                  key={i}
                  className={`flex items-end gap-2 ${msg.role === 'user' ? 'ml-auto max-w-[75%] flex-row-reverse' : 'flex-row'}`}
                >
                  {/* Avatar */}
                  <div className="border-fl-border mb-0.5 h-7 w-7 flex-shrink-0 overflow-hidden rounded-full border">
                    {msg.role === 'assistant' ? (
                      <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-sky-100 to-blue-200 dark:from-sky-900/60 dark:to-blue-950">
                        <LinguistLogoMark size={20} />
                      </div>
                    ) : user?.avatar ? (
                      <AuthAvatarImage
                        avatar={user.avatar}
                        alt=""
                        width={28}
                        height={28}
                        className="h-full w-full object-cover"
                        fallback={
                          <div className="bg-fl-surface-2 flex h-full w-full items-center justify-center">
                            <span className="text-fl-hint text-fl-muted-1 font-mono select-none">
                              {(user?.displayName ||
                                user?.username ||
                                '?')[0].toUpperCase()}
                            </span>
                          </div>
                        }
                      />
                    ) : (
                      <div className="bg-fl-surface-2 flex h-full w-full items-center justify-center">
                        <span className="text-fl-hint text-fl-muted-1 font-mono select-none">
                          {(user?.displayName ||
                            user?.username ||
                            '?')[0].toUpperCase()}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className={`max-w-[75%] min-w-[10rem] text-left`}>
                    <TargetLanguageText
                      as="div"
                      languageCode={targetLanguageCode}
                      className={`word-selectable max-w-[70ch] rounded-2xl border px-4 py-3 text-left ${msg.role === 'user'
                          ? 'neu-button-primary border-blue-400/40 text-white'
                          : 'glass-card text-fl-fg-2'
                        }`}
                      onPointerUp={
                        msg.role === 'assistant' &&
                          !(sending && i === messages.length - 1)
                          ? () => handleTextSelection(msg.content)
                          : undefined
                      }
                    >
                      {msg.content ? (
                        msg.role === 'assistant' ? (
                          <ChatMarkdown>{msg.content}</ChatMarkdown>
                        ) : (
                          msg.content
                        )
                      ) : sending && i === messages.length - 1 ? (
                        <span className="text-fl-muted-2 animate-pulse">▌</span>
                      ) : null}
                    </TargetLanguageText>
                    {msg.role === 'assistant' &&
                      msg.content &&
                      !(sending && i === messages.length - 1) && (
                        <div className="mt-1">
                          <AudioPlayer
                            text={msg.content}
                            conversationId={activeId ?? undefined}
                            size="sm"
                          />
                        </div>
                      )}
                  </div>
                </div>
              ))
            )}
            {error && (
              <div className="text-fl-label text-fl-error-fg border-fl-error/30 border px-4 py-2 font-mono">
                ✕{' '}
                {error === 'No active study plan found'
                  ? tCommon('noActivePlan')
                  : error}
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="glass-panel border-fl-border/60 shrink-0 border-t px-4 py-4">
            {freemiumExhausted ? (
              <PaywallBanner feature="chat" compact />
            ) : (
              <>
                <div className="flex gap-2.5">
                  <input
                    ref={inputRef}
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) =>
                      e.key === 'Enter' && !e.shiftKey && sendMessage()
                    }
                    disabled={sending || historyUnavailable}
                    placeholder={t('placeholder')}
                    className="neu-input text-fl-fg placeholder:text-fl-muted-3 flex-1 rounded-xl px-4 py-3 font-mono text-base font-medium focus:outline-none disabled:opacity-40"
                  />
                  <button
                    onClick={sendMessage}
                    disabled={sending || !input.trim() || historyUnavailable}
                    className="neu-button-primary rounded-xl px-6 font-mono text-sm font-bold tracking-widest text-white uppercase disabled:opacity-30"
                  >
                    {sending ? '...' : t('send')}
                  </button>
                </div>
                <p className="text-fl-hint text-fl-muted-2 mt-2 font-mono font-semibold tracking-wide">
                  {t('enterToSend')}
                </p>
              </>
            )}
          </div>
        </div>

        <ConfirmDialog
          open={deletePending !== null}
          title={t('deleteTitle')}
          message={t('deleteMessage')}
          confirmLabel={t('deleteConfirm')}
          danger
          confirming={deletingId !== null}
          onConfirm={() =>
            deletePending !== null && deleteConversation(deletePending)
          }
          onCancel={() => setDeletePending(null)}
        />

        {/* Word-save tooltip */}
        {selectedWord && (
          <WordTooltip
            word={selectedWord}
            pos={tooltipPos}
            saveState={saveState}
            onSave={() => handleSaveWord()}
            onDismiss={dismissTooltip}
            labels={{
              saveWord: tCommon('saveWord'),
              wordSaved: tCommon('wordSaved'),
              wordAlreadySaved: tCommon('wordAlreadySaved'),
              wordSaveError: tCommon('wordSaveError'),
            }}
          />
        )}
      </div>
    </MaintenanceGate>
  )
}
