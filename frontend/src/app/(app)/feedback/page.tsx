'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { apiFetch } from '@/lib/api'
import { useAuthStore } from '@/store/auth'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { PageLoading } from '@/components/ui/page-loading'
import { Pagination } from '@/components/ui/pagination'
import { AdminAuthorBadge } from '@/components/feedback/AdminAuthorBadge'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FeedbackAuthor {
  id: number
  username: string
  display_name: string
  role: 'admin' | 'user'
}

interface FeedbackEntry {
  id: number
  type: 'feature' | 'bug'
  title: string
  description: string
  status: string
  author: FeedbackAuthor
  vote_count: number
  voted_by_me: boolean
  unread_by_me: boolean
  comment_count: number
  created_at: string
}

interface FeedbackComment {
  id: number
  entry_id: number
  author: FeedbackAuthor
  body: string
  created_at: string
}

type Tab = 'feature' | 'bug'
type SortOption = 'votes' | 'date'

const PAGE_SIZE = 10

const STATUS_STYLES: Record<string, string> = {
  pending: 'border-fl-border text-fl-muted-2 bg-white/40 dark:bg-white/5',
  planned:
    'border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300',
  in_progress:
    'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  done: 'border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-300',
  declined: 'border-fl-error/40 bg-fl-error/10 text-fl-error-fg',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status, label }: { status: string; label: string }) {
  const cls = STATUS_STYLES[status] ?? STATUS_STYLES.pending
  return (
    <span
      className={`text-fl-hint rounded-full border px-2.5 py-0.5 font-mono font-semibold tracking-widest uppercase ${cls}`}
    >
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Create modal
// ---------------------------------------------------------------------------

interface CreateModalProps {
  type: Tab
  onClose: () => void
  onCreated: () => void
}

function CreateModal({ type, onClose, onCreated }: CreateModalProps) {
  const t = useTranslations('feedback')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const inputCls =
    'w-full neu-input rounded-xl px-4 py-3 font-mono text-xs font-medium text-fl-fg placeholder:text-fl-muted-3 focus:outline-none transition-all resize-none'
  const textareaCls =
    'w-full neu-input rounded-xl px-4 py-3 font-mono text-xs font-medium text-fl-fg placeholder:text-fl-muted-3 focus:outline-none transition-all resize-y min-h-[106px]'

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const res = await apiFetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          title: title.trim(),
          description: description.trim(),
        }),
      })
      if (!res.ok) throw new Error()
      onCreated()
    } catch {
      setError(t('errorSubmit'))
    } finally {
      setSubmitting(false)
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      style={{
        backgroundColor: 'rgba(0,0,0,0.7)',
        backdropFilter: 'blur(2px)',
      }}
      onClick={onClose}
    >
      <div
        className="neu-glass-card w-full max-w-md overflow-hidden rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="border-fl-border/60 flex items-center justify-between border-b px-6 py-4">
          <div className="flex items-center gap-2">
            <span className="text-fl-accent text-fl-label">●</span>
            <span className="text-fl-label text-fl-fg font-mono font-bold tracking-widest uppercase">
              {type === 'feature'
                ? t('modalCreateTitleFeature')
                : t('modalCreateTitleBug')}
            </span>
          </div>
          <button
            onClick={onClose}
            className="neu-button text-fl-label text-fl-fg rounded-full px-2.5 py-1 font-mono font-bold transition-all"
          >
            ✕
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4 p-6">
          {error && (
            <div className="border-fl-error/40 text-fl-error glass-card rounded-xl border px-4 py-3 font-mono text-xs font-semibold">
              ✕ {error}
            </div>
          )}
          <div>
            <label className="text-fl-fg mb-1.5 block font-mono text-xs font-semibold tracking-widest uppercase">
              {t('labelTitle')}
            </label>
            <input
              type="text"
              required
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                type === 'feature'
                  ? t('placeholderTitleFeature')
                  : t('placeholderTitleBug')
              }
              className={inputCls}
              autoFocus
            />
          </div>
          <div>
            <label className="text-fl-fg mb-1.5 block font-mono text-xs font-semibold tracking-widest uppercase">
              {t('labelDescription')}
            </label>
            <textarea
              required
              maxLength={5000}
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={
                type === 'feature'
                  ? t('placeholderDescriptionFeature')
                  : t('placeholderDescriptionBug')
              }
              className={textareaCls}
            />
          </div>
          <div className="flex gap-2.5 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="neu-button text-fl-fg flex-1 rounded-xl px-4 py-3 font-mono text-xs font-semibold tracking-widest uppercase transition-all"
            >
              {t('cancel')}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="neu-button-primary flex-1 rounded-xl py-3 font-mono text-sm font-bold tracking-widest uppercase transition-all disabled:opacity-50"
            >
              {submitting ? t('submitting') : t('submit')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

interface DetailViewProps {
  entry: FeedbackEntry
  currentUserId: number | undefined
  isAdmin: boolean
  getStatusLabel: (status: string) => string
  onBack: () => void
  onVoteToggled: (entryId: number, voted: boolean, voteCount: number) => void
  onEntryRead: (entryId: number) => void
  onEntryDeleted: (entryId: number) => void
}

function DetailView({
  entry: initialEntry,
  currentUserId,
  isAdmin,
  getStatusLabel,
  onBack,
  onVoteToggled,
  onEntryRead,
  onEntryDeleted,
}: DetailViewProps) {
  const t = useTranslations('feedback')
  const locale = useLocale()
  const [entry, setEntry] = useState(initialEntry)
  const [comments, setComments] = useState<FeedbackComment[]>([])
  const [commentBody, setCommentBody] = useState('')
  const [postingComment, setPostingComment] = useState(false)
  const [deletePendingComment, setDeletePendingComment] =
    useState<FeedbackComment | null>(null)
  const [deleteEntryPending, setDeleteEntryPending] = useState(false)
  const [voting, setVoting] = useState(false)
  const [error, setError] = useState('')

  // Load comments on mount
  useEffect(() => {
    apiFetch(`/api/feedback/${entry.id}/read`, { method: 'POST' })
      .then((r) => {
        if (r.ok) {
          onEntryRead(entry.id)
          window.dispatchEvent(new Event('freelingo:feedback-read'))
        }
      })
      .catch(() => {})

    apiFetch(`/api/feedback/${entry.id}/comments`)
      .then((r) => r.json())
      .then((d) => setComments(d.items ?? []))
      .catch(() => {})
  }, [entry.id, onEntryRead])

  async function handleVote() {
    if (voting) return
    setVoting(true)
    try {
      const res = await apiFetch(`/api/feedback/${entry.id}/vote`, {
        method: 'POST',
      })
      if (res.ok) {
        const data = await res.json()
        setEntry((e) => ({
          ...e,
          voted_by_me: data.voted,
          vote_count: data.vote_count,
        }))
        onVoteToggled(entry.id, data.voted, data.vote_count)
      }
    } finally {
      setVoting(false)
    }
  }

  async function handlePostComment(e: React.FormEvent) {
    e.preventDefault()
    if (!commentBody.trim()) return
    setPostingComment(true)
    setError('')
    try {
      const res = await apiFetch(`/api/feedback/${entry.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: commentBody.trim() }),
      })
      if (!res.ok) throw new Error()
      const comment: FeedbackComment = await res.json()
      setComments((prev) => [...prev, comment])
      setEntry((e) => ({ ...e, comment_count: e.comment_count + 1 }))
      setCommentBody('')
    } catch {
      setError(t('errorSubmit'))
    } finally {
      setPostingComment(false)
    }
  }

  async function handleDeleteComment(comment: FeedbackComment) {
    await apiFetch(`/api/feedback/${entry.id}/comments/${comment.id}`, {
      method: 'DELETE',
    })
    setComments((prev) => prev.filter((c) => c.id !== comment.id))
    setEntry((e) => ({ ...e, comment_count: Math.max(0, e.comment_count - 1) }))
    setDeletePendingComment(null)
  }

  async function handleDeleteEntry() {
    await apiFetch(`/api/feedback/${entry.id}`, { method: 'DELETE' })
    setDeleteEntryPending(false)
    onEntryDeleted(entry.id)
    onBack()
  }

  const statusLabel = getStatusLabel(entry.status)

  return (
    <div className="space-y-4">
      {/* Back */}
      <button
        onClick={onBack}
        className="neu-button text-fl-label text-fl-fg rounded-xl px-3.5 py-2 font-mono font-semibold tracking-widest uppercase transition-all"
      >
        {t('backToList')}
      </button>

      {/* Entry card */}
      <div className="glass-card overflow-hidden rounded-2xl">
        <div className="border-fl-border/60 space-y-3 border-b px-6 py-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 className="text-fl-fg min-w-0 flex-1 font-mono text-base leading-snug font-bold">
              {entry.title}
            </h2>
            <StatusBadge status={entry.status} label={statusLabel} />
          </div>
          <p className="text-fl-fg font-mono text-xs font-medium leading-relaxed whitespace-pre-wrap">
            {entry.description}
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <span className="text-fl-hint text-fl-muted-2 inline-flex flex-wrap items-center gap-x-1 font-mono font-medium">
              <span>
                {t('by')} {entry.author.display_name}
              </span>
              <AdminAuthorBadge role={entry.author.role} />
              <span>· {formatDate(entry.created_at, locale)}</span>
            </span>
            {/* Vote button — only for features */}
            {entry.type === 'feature' && (
              <button
                onClick={handleVote}
                disabled={voting}
                className={`text-fl-hint rounded-full px-3.5 py-1.5 font-mono font-bold tracking-widest uppercase transition-all disabled:opacity-50 ${
                  entry.voted_by_me
                    ? 'neu-button-primary'
                    : 'neu-button text-fl-fg'
                }`}
              >
                ▲ {entry.vote_count}
              </button>
            )}
            {/* Delete — author or admin */}
            {(currentUserId === entry.author.id || isAdmin) && (
              <button
                onClick={() => setDeleteEntryPending(true)}
                className="neu-button text-fl-hint border-fl-error/30 text-fl-error-fg ml-auto rounded-xl px-3.5 py-1.5 font-mono font-semibold tracking-widest uppercase transition-all"
              >
                {t('deleteEntry')}
              </button>
            )}
          </div>
        </div>

        {/* Comments */}
        <div className="divide-fl-border/60 divide-y">
          {comments.length === 0 ? (
            <p className="text-fl-muted-2 px-6 py-6 text-center font-mono text-xs font-medium">
              {t('addComment')}
            </p>
          ) : (
            comments.map((c) => (
              <div key={c.id} className="space-y-1 px-6 py-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-fl-hint text-fl-muted-2 inline-flex flex-wrap items-center gap-x-1 font-mono font-semibold">
                    <span>{c.author.display_name}</span>
                    <AdminAuthorBadge role={c.author.role} />
                    <span>· {formatDate(c.created_at, locale)}</span>
                  </span>
                  {currentUserId === c.author.id && (
                    <button
                      onClick={() => setDeletePendingComment(c)}
                      className="neu-button text-fl-hint text-fl-error-fg rounded-lg px-2.5 py-1 font-mono font-semibold tracking-widest uppercase transition-all"
                    >
                      {t('deleteComment')}
                    </button>
                  )}
                </div>
                <p className="text-fl-fg font-mono text-xs font-medium leading-relaxed whitespace-pre-wrap">
                  {c.body}
                </p>
              </div>
            ))
          )}
        </div>

        {/* Add comment form */}
        <form
          onSubmit={handlePostComment}
          className="border-fl-border/60 space-y-3 border-t px-6 py-4"
        >
          {error && (
            <div className="border-fl-error/40 text-fl-error glass-card rounded-xl border px-4 py-2 font-mono text-xs font-semibold">
              ✕ {error}
            </div>
          )}
          <textarea
            rows={2}
            value={commentBody}
            onChange={(e) => setCommentBody(e.target.value)}
            placeholder={t('commentPlaceholder')}
            maxLength={2000}
            className="neu-input text-fl-fg placeholder:text-fl-muted-3 min-h-[50px] w-full resize-y rounded-xl px-4 py-2.5 font-mono text-xs font-medium transition-all focus:outline-none"
          />
          <button
            type="submit"
            disabled={postingComment || !commentBody.trim()}
            className="neu-button-primary rounded-xl px-5 py-2.5 font-mono text-sm font-bold tracking-widest uppercase transition-all disabled:cursor-not-allowed disabled:opacity-40"
          >
            {postingComment ? t('postingComment') : t('postComment')}
          </button>
        </form>
      </div>

      {/* Confirm delete entry */}
      <ConfirmDialog
        open={deleteEntryPending}
        title={t('deleteEntryConfirmTitle')}
        message={t('deleteEntryConfirmMessage')}
        confirmLabel={t('deleteEntryConfirm')}
        danger
        onConfirm={handleDeleteEntry}
        onCancel={() => setDeleteEntryPending(false)}
      />

      {/* Confirm delete comment */}
      <ConfirmDialog
        open={deletePendingComment !== null}
        title={t('deleteCommentConfirmTitle')}
        message={t('deleteCommentConfirmMessage')}
        confirmLabel={t('deleteCommentConfirm')}
        danger
        onConfirm={() =>
          deletePendingComment && handleDeleteComment(deletePendingComment)
        }
        onCancel={() => setDeletePendingComment(null)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function FeedbackPage() {
  const sessionVersion = useAuthStore((s) => s.sessionVersion)
  return <FeedbackContent key={sessionVersion} />
}

function FeedbackContent() {
  const t = useTranslations('feedback')
  const tCommon = useTranslations('common')
  const locale = useLocale()
  const currentUserId = useAuthStore((s) => s.user?.id)
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin')

  const [tab, setTab] = useState<Tab>('feature')
  const [sort, setSort] = useState<SortOption>('votes')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [entries, setEntries] = useState<FeedbackEntry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const loadController = useRef<AbortController | null>(null)
  const listContext = useRef('')
  const [votingId, setVotingId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [reload, setReload] = useState(0)

  // Detail view
  const [selectedEntry, setSelectedEntry] = useState<FeedbackEntry | null>(null)

  // Delete confirm (from list)
  const [deletePending, setDeletePending] = useState<FeedbackEntry | null>(null)

  const loadEntries = useCallback(
    async (
      pageIndex: number,
      currentTab: Tab,
      currentSort: SortOption,
      currentStatus: string
    ) => {
      loadController.current?.abort()
      const controller = new AbortController()
      loadController.current = controller
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(20_000),
      ])
      const context = JSON.stringify([
        pageIndex,
        currentTab,
        currentSort,
        currentStatus,
      ])
      if (listContext.current !== context) {
        setEntries([])
        setTotal(0)
        listContext.current = context
      }
      setLoading(true)
      setError('')
      try {
        const params = new URLSearchParams({
          type: currentTab,
          sort: currentSort,
          order: 'desc',
          skip: String(pageIndex * PAGE_SIZE),
          limit: String(PAGE_SIZE),
        })
        if (currentStatus) params.set('status', currentStatus)
        const res = await apiFetch(`/api/feedback?${params.toString()}`, {
          signal,
        })
        if (!res.ok) throw new Error()
        const data = await res.json()
        signal.throwIfAborted()
        if (loadController.current !== controller) return
        setEntries(data.items)
        setTotal(data.total)
      } catch {
        if (loadController.current === controller) setError(t('errorLoad'))
      } finally {
        if (loadController.current === controller) setLoading(false)
      }
    },
    [t]
  )

  useEffect(() => {
    loadEntries(page, tab, sort, statusFilter)
    return () => {
      loadController.current?.abort()
      loadController.current = null
    }
  }, [loadEntries, page, tab, sort, statusFilter, reload])

  function handleVoteToggled(
    entryId: number,
    voted: boolean,
    voteCount: number
  ) {
    setEntries((prev) =>
      prev.map((e) =>
        e.id === entryId
          ? { ...e, voted_by_me: voted, vote_count: voteCount }
          : e
      )
    )
  }

  const handleEntryRead = useCallback((entryId: number) => {
    setEntries((prev) =>
      prev.map((e) => (e.id === entryId ? { ...e, unread_by_me: false } : e))
    )
    setSelectedEntry((entry) =>
      entry?.id === entryId ? { ...entry, unread_by_me: false } : entry
    )
  }, [])

  function handleEntryDeleted(entryId: number) {
    if (!loadController.current) return
    const newTotal = total - 1
    setTotal(newTotal)
    setEntries((prev) => prev.filter((e) => e.id !== entryId))
    const maxPage = Math.max(0, Math.ceil(newTotal / PAGE_SIZE) - 1)
    const targetPage = Math.min(page, maxPage)
    if (targetPage !== page) {
      setPage(targetPage)
    } else {
      loadEntries(targetPage, tab, sort, statusFilter)
    }
  }

  async function handleDeleteFromList(entry: FeedbackEntry) {
    if (deletingId !== null || loading) return
    const owner = loadController.current
    setDeletingId(entry.id)
    try {
      const res = await apiFetch(`/api/feedback/${entry.id}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error()
      if (!loadController.current) return
      setDeletePending(null)
      if (loadController.current === owner) handleEntryDeleted(entry.id)
      else setReload((value) => value + 1)
    } catch {
      if (loadController.current === owner) setError(t('errorSubmit'))
    } finally {
      if (loadController.current) setDeletingId(null)
    }
  }

  const statusOptions = useMemo(
    () => [
      { value: '', label: t('filterAll') },
      ...[
        { value: 'pending', label: t('statusPending') },
        { value: 'planned', label: t('statusPlanned') },
        { value: 'in_progress', label: t('statusInProgress') },
        { value: 'done', label: t('statusDone') },
        { value: 'declined', label: t('statusDeclined') },
      ].sort((a, b) => a.label.localeCompare(b.label)),
    ],
    [t]
  )

  function getStatusLabel(status: string) {
    return statusOptions.find((o) => o.value === status)?.label ?? status
  }

  // If a detail view is open, render it instead
  if (selectedEntry) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <DetailView
          entry={selectedEntry}
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          getStatusLabel={getStatusLabel}
          onBack={() => setSelectedEntry(null)}
          onVoteToggled={handleVoteToggled}
          onEntryRead={handleEntryRead}
          onEntryDeleted={handleEntryDeleted}
        />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      {/* Page header */}
      <div className="border-fl-border/60 border-b pb-4">
        <p className="text-fl-label text-fl-accent mb-1 font-mono font-bold tracking-widest uppercase">
          {t('title')}
        </p>
        <h1 className="text-fl-fg font-mono text-2xl font-bold tracking-tight">
          {t('subtitle')}
        </h1>
      </div>

      {/* Tabs */}
      <div className="glass-card flex flex-wrap items-center gap-2 rounded-2xl p-2">
        {(['feature', 'bug'] as Tab[]).map((tabOption) => (
          <button
            key={tabOption}
            onClick={() => {
              setPage(0)
              setTab(tabOption)
            }}
            className={`rounded-xl px-4 py-2 font-mono text-xs font-semibold tracking-widest uppercase transition-all ${
              tab === tabOption
                ? 'neu-button-primary'
                : 'neu-button text-fl-muted-2 hover:text-fl-fg'
            }`}
          >
            {tabOption === 'feature' ? t('tabFeatures') : t('tabBugs')}
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={() => setShowCreate(true)}
          className="neu-button-primary rounded-xl px-4 py-2 font-mono text-xs font-bold tracking-widest uppercase transition-all"
        >
          {tab === 'feature' ? t('newFeature') : t('newBug')}
        </button>
      </div>

      {/* Filters + sort row */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-fl-hint text-fl-muted-2 font-mono font-semibold tracking-widest uppercase">
          {t('sortBy')}
        </span>
        {(['votes', 'date'] as SortOption[]).map((s) => (
          <button
            key={s}
            onClick={() => {
              setPage(0)
              setSort(s)
            }}
            className={`text-fl-hint rounded-full px-3.5 py-1.5 font-mono font-semibold tracking-widest uppercase transition-all ${
              sort === s
                ? 'neu-button-primary'
                : 'neu-button text-fl-muted-2 hover:text-fl-fg'
            }`}
          >
            {s === 'votes' ? t('sortVotes') : t('sortDate')}
          </button>
        ))}

        <span className="text-fl-hint text-fl-muted-2 ml-2 font-mono font-semibold tracking-widest uppercase">
          {t('filterStatus')}
        </span>
        <select
          value={statusFilter}
          onChange={(e) => {
            setPage(0)
            setStatusFilter(e.target.value)
          }}
          className="neu-input text-fl-hint text-fl-fg appearance-none rounded-xl px-3.5 py-1.5 font-mono font-semibold transition-all focus:outline-none"
        >
          {statusOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* Error */}
      {error && (
        <div className="border-fl-error/40 text-fl-error glass-card rounded-2xl border px-4 py-3 font-mono text-xs font-semibold">
          ✕ {error}
          <button
            onClick={() => loadEntries(page, tab, sort, statusFilter)}
            disabled={loading}
            className="neu-button ml-3 rounded-lg px-2.5 py-1 font-semibold disabled:opacity-50"
          >
            {tCommon('retry')}
          </button>
        </div>
      )}

      {/* List */}
      <div className="glass-card overflow-hidden rounded-2xl">
        {loading && (
          <PageLoading
            fullScreen={false}
            className="block px-6 py-10 text-center"
          />
        )}
        {entries.length === 0 ? (
          !loading &&
          !error && (
            <p className="text-fl-muted-2 px-6 py-10 text-center font-mono text-xs font-semibold">
              {t('noEntries')}
            </p>
          )
        ) : (
          <div>
            {entries.map((entry, i) => {
              const canDelete = currentUserId === entry.author.id || isAdmin
              const voteLabel = t(
                entry.voted_by_me ? 'removeVoteAction' : 'voteAction'
              )
              return (
                <div
                  key={entry.id}
                  className={`flex cursor-pointer gap-4 px-5 py-4 transition-colors hover:bg-white/40 dark:hover:bg-white/5 ${
                    i < entries.length - 1 ? 'border-fl-border/60 border-b' : ''
                  }`}
                  onClick={() => setSelectedEntry(entry)}
                >
                  {/* Vote column — only for features */}
                  {entry.type === 'feature' && (
                    <div
                      className="flex shrink-0 flex-col items-center gap-1 pt-0.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        disabled={loading || votingId !== null}
                        onClick={async (e) => {
                          e.stopPropagation()
                          if (loading || votingId !== null) return
                          const owner = loadController.current
                          const sessionVersion =
                            useAuthStore.getState().sessionVersion
                          setVotingId(entry.id)
                          try {
                            const res = await apiFetch(
                              `/api/feedback/${entry.id}/vote`,
                              { method: 'POST' }
                            )
                            if (!res.ok) throw new Error()
                            const data = await res.json()
                            if (
                              useAuthStore.getState().sessionVersion !==
                              sessionVersion
                            ) {
                              return
                            }
                            if (loadController.current !== owner) {
                              if (loadController.current) {
                                setReload((value) => value + 1)
                              }
                              return
                            }
                            handleVoteToggled(
                              entry.id,
                              data.voted,
                              data.vote_count
                            )
                          } catch {
                            if (loadController.current === owner) {
                              setError(t('errorSubmit'))
                            }
                          } finally {
                            if (loadController.current) setVotingId(null)
                          }
                        }}
                        className={`rounded-xl px-2.5 py-1.5 font-mono text-sm leading-none font-bold transition-all ${
                          entry.voted_by_me
                            ? 'neu-button-primary'
                            : 'neu-button text-fl-fg'
                        }`}
                        title={voteLabel}
                        aria-label={voteLabel}
                      >
                        ▲
                      </button>
                      <span className="text-fl-hint text-fl-fg font-mono font-bold tabular-nums">
                        {entry.vote_count}
                      </span>
                    </div>
                  )}
                  {/* Bug entries — show placeholder column for alignment */}
                  {entry.type === 'bug' && <div className="w-8 shrink-0" />}

                  {/* Content */}
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-fl-fg truncate font-mono text-sm font-bold">
                        {entry.title}
                      </span>
                      <StatusBadge
                        status={entry.status}
                        label={getStatusLabel(entry.status)}
                      />
                      {entry.unread_by_me && (
                        <span className="text-fl-label rounded-full border border-red-500/40 bg-red-500/10 px-2.5 py-0.5 font-mono leading-none font-bold tracking-widest text-red-600 uppercase dark:text-red-400">
                          {t('unread')}
                        </span>
                      )}
                    </div>
                    <p className="text-fl-muted-2 line-clamp-2 font-mono text-xs font-medium leading-relaxed">
                      {entry.description}
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="text-fl-hint text-fl-muted-2 inline-flex flex-wrap items-center gap-x-1 font-mono font-medium">
                        <span>
                          {t('by')} {entry.author.display_name}
                        </span>
                        <AdminAuthorBadge role={entry.author.role} />
                        <span>· {formatDate(entry.created_at, locale)}</span>
                      </span>
                      {entry.comment_count > 0 && (
                        <span className="text-fl-hint text-fl-muted-2 font-mono font-medium">
                          ◌{' '}
                          {entry.comment_count === 1
                            ? t('comment')
                            : t('comments', { count: entry.comment_count })}
                        </span>
                      )}
                      {canDelete && (
                        <button
                          disabled={loading || deletingId !== null}
                          onClick={(e) => {
                            e.stopPropagation()
                            setDeletePending(entry)
                          }}
                          className="neu-button text-fl-hint text-fl-error-fg ml-auto rounded-lg px-2.5 py-1 font-mono font-semibold tracking-widest uppercase transition-all"
                        >
                          {t('deleteEntry')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Pagination */}
      <Pagination
        page={page}
        totalPages={Math.ceil(total / PAGE_SIZE)}
        onPageChange={setPage}
        prevLabel={t('prevPage')}
        nextLabel={t('nextPage')}
      />

      {/* Create modal */}
      {showCreate && (
        <CreateModal
          type={tab}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            if (!loadController.current) return
            setShowCreate(false)
            setPage(0)
            setReload((value) => value + 1)
          }}
        />
      )}

      {/* Confirm delete from list */}
      <ConfirmDialog
        open={deletePending !== null}
        title={t('deleteEntryConfirmTitle')}
        message={t('deleteEntryConfirmMessage')}
        confirmLabel={t('deleteEntryConfirm')}
        danger
        confirming={deletingId !== null}
        onConfirm={() => deletePending && handleDeleteFromList(deletePending)}
        onCancel={() => setDeletePending(null)}
      />
    </div>
  )
}
