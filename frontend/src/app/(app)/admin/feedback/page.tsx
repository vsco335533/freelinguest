'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import {
  Bug,
  FilterX,
  Loader2,
  MessageSquareText,
  Search,
  ThumbsUp,
  Trash2,
} from 'lucide-react'
import { AdminNav } from '@/components/admin/AdminNav'
import {
  AdminBadge,
  AdminMetric,
  AdminPageHeader,
  AdminPanel,
} from '@/components/admin/AdminShell'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { PageLoading } from '@/components/ui/page-loading'
import { Pagination } from '@/components/ui/pagination'
import { AdminAuthorBadge } from '@/components/feedback/AdminAuthorBadge'
import { apiFetch } from '@/lib/api'
import { useAuthStore } from '@/store/auth'

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
  comment_count: number
  created_at: string
}

type TypeFilter = 'all' | 'feature' | 'bug'
type SortFilter = 'date' | 'votes'

const PAGE_SIZE = 10

const STATUS_OPTIONS = [
  'pending',
  'planned',
  'in_progress',
  'done',
  'declined',
] as const

const STATUS_TONES: Record<
  string,
  'neutral' | 'info' | 'success' | 'warning' | 'danger'
> = {
  pending: 'neutral',
  planned: 'info',
  in_progress: 'warning',
  done: 'success',
  declined: 'danger',
}

function formatDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export default function AdminFeedbackPage() {
  const sessionVersion = useAuthStore((s) => s.sessionVersion)
  return <AdminFeedbackContent key={sessionVersion} />
}

function AdminFeedbackContent() {
  const t = useTranslations('feedback')
  const tCommon = useTranslations('common')
  const tAdmin = useTranslations('admin')
  const locale = useLocale()
  const searchParams = useSearchParams()

  const [entries, setEntries] = useState<FeedbackEntry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [searchInput, setSearchInput] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>(() => {
    const type = searchParams.get('type')
    return type === 'feature' || type === 'bug' ? type : 'all'
  })
  const [statusFilter, setStatusFilter] = useState(() => {
    const status = searchParams.get('status')
    return STATUS_OPTIONS.includes(status as (typeof STATUS_OPTIONS)[number])
      ? status || ''
      : ''
  })
  const [sortFilter, setSortFilter] = useState<SortFilter>(() =>
    searchParams.get('sort') === 'votes' ? 'votes' : 'date'
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [typeTotals, setTypeTotals] = useState({ feature: 0, bug: 0 })
  const [savingStatus, setSavingStatus] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [deletePending, setDeletePending] = useState<FeedbackEntry | null>(null)
  const loadController = useRef<AbortController | null>(null)
  const listContext = useRef('')
  const [reload, setReload] = useState(0)

  const getStatusLabel = useCallback(
    (status: string): string => {
      const map: Record<string, string> = {
        pending: t('statusPending'),
        planned: t('statusPlanned'),
        in_progress: t('statusInProgress'),
        done: t('statusDone'),
        declined: t('statusDeclined'),
      }
      return map[status] ?? status
    },
    [t]
  )

  const loadTypeTotal = useCallback(
    async (
      type: 'feature' | 'bug',
      query: string,
      currentStatus: string,
      signal: AbortSignal
    ) => {
      const params = new URLSearchParams({
        type,
        skip: '0',
        limit: '1',
      })
      if (query.trim()) params.set('q', query.trim())
      if (currentStatus) params.set('status', currentStatus)
      const res = await apiFetch(`/api/feedback?${params.toString()}`, {
        signal,
      })
      if (!res.ok) throw new Error()
      const data = await res.json()
      return data.total ?? 0
    },
    []
  )

  const loadEntries = useCallback(
    async (
      pageIndex: number,
      query: string,
      currentType: TypeFilter,
      currentStatus: string,
      currentSort: SortFilter
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
        query,
        currentType,
        currentStatus,
        currentSort,
      ])
      if (listContext.current !== context) {
        setEntries([])
        setTotal(0)
        setTypeTotals({ feature: 0, bug: 0 })
        listContext.current = context
      }
      setLoading(true)
      setError('')
      try {
        const params = new URLSearchParams({
          sort: currentSort,
          order: 'desc',
          skip: String(pageIndex * PAGE_SIZE),
          limit: String(PAGE_SIZE),
        })
        if (query.trim()) params.set('q', query.trim())
        if (currentType !== 'all') params.set('type', currentType)
        if (currentStatus) params.set('status', currentStatus)

        const res = await apiFetch(`/api/feedback?${params.toString()}`, {
          signal,
        })
        if (loadController.current !== controller) return
        signal.throwIfAborted()
        if (res.status === 403) {
          setError(tAdmin('adminRequired'))
          return
        }
        if (!res.ok) throw new Error()
        const [data, featureCount, bugCount] = await Promise.all([
          res.json(),
          loadTypeTotal('feature', query, currentStatus, signal),
          loadTypeTotal('bug', query, currentStatus, signal),
        ])
        signal.throwIfAborted()
        if (loadController.current !== controller) return
        setEntries(data.items)
        setTotal(data.total)
        setTypeTotals({ feature: featureCount, bug: bugCount })
      } catch {
        if (loadController.current === controller) setError(t('errorLoad'))
      } finally {
        if (loadController.current === controller) setLoading(false)
      }
    },
    [loadTypeTotal, t, tAdmin]
  )

  useEffect(() => {
    loadEntries(page, searchTerm, typeFilter, statusFilter, sortFilter)
    return () => {
      loadController.current?.abort()
      loadController.current = null
    }
  }, [
    loadEntries,
    page,
    searchTerm,
    typeFilter,
    statusFilter,
    sortFilter,
    reload,
  ])

  function handleSearch() {
    setSearchTerm(searchInput)
    setPage(0)
    setReload((value) => value + 1)
  }

  function clearFilters() {
    setSearchInput('')
    setSearchTerm('')
    setTypeFilter('all')
    setStatusFilter('')
    setSortFilter('date')
    setPage(0)
  }

  async function handleStatusChange(entry: FeedbackEntry, newStatus: string) {
    if (
      entry.status === newStatus ||
      loading ||
      savingStatus !== null ||
      deletingId !== null
    )
      return
    const owner = loadController.current
    setSavingStatus(entry.id)
    setError('')
    try {
      const res = await apiFetch(`/api/feedback/${entry.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      if (!res.ok) throw new Error()
      if (loadController.current !== owner) {
        if (loadController.current) setReload((value) => value + 1)
        return
      }
      if (statusFilter && newStatus !== statusFilter) {
        await loadEntries(
          page,
          searchTerm,
          typeFilter,
          statusFilter,
          sortFilter
        )
        return
      }
      setEntries((prev) =>
        prev.map((e) => (e.id === entry.id ? { ...e, status: newStatus } : e))
      )
    } catch {
      if (loadController.current === owner)
        setError(tAdmin('feedbackStatusError'))
    } finally {
      if (loadController.current) setSavingStatus(null)
    }
  }

  async function handleDelete(entry: FeedbackEntry) {
    if (loading || savingStatus !== null || deletingId !== null) return
    const owner = loadController.current
    setDeletingId(entry.id)
    setError('')
    try {
      const res = await apiFetch(`/api/feedback/${entry.id}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error()
      if (!loadController.current) return
      setDeletePending(null)
      if (loadController.current !== owner) {
        setReload((value) => value + 1)
        return
      }
      const newTotal = total - 1
      setTotal(newTotal)
      setEntries((prev) => prev.filter((e) => e.id !== entry.id))
      const maxPage = Math.max(0, Math.ceil(newTotal / PAGE_SIZE) - 1)
      const targetPage = Math.min(page, maxPage)
      if (targetPage !== page) {
        setPage(targetPage)
      } else {
        await loadEntries(
          targetPage,
          searchTerm,
          typeFilter,
          statusFilter,
          sortFilter
        )
      }
    } catch {
      if (loadController.current === owner)
        setError(tAdmin('feedbackDeleteError'))
    } finally {
      if (loadController.current) setDeletingId(null)
    }
  }

  const typeFilterOptions: { value: TypeFilter; label: string }[] = useMemo(
    () => [
      { value: 'all', label: tAdmin('allFeedback') },
      ...[
        { value: 'feature' as const, label: t('tabFeatures') },
        { value: 'bug' as const, label: t('tabBugs') },
      ].sort((a, b) => a.label.localeCompare(b.label)),
    ],
    [t, tAdmin]
  )

  const feedbackStatusOptions = useMemo(
    () =>
      STATUS_OPTIONS.map((s) => ({
        value: s,
        label: getStatusLabel(s),
      })).sort((a, b) => a.label.localeCompare(b.label)),
    [getStatusLabel]
  )

  const statusFilterOptions = useMemo(
    () => [{ value: '', label: t('filterAll') }, ...feedbackStatusOptions],
    [feedbackStatusOptions, t]
  )

  const sortFilterOptions: { value: SortFilter; label: string }[] = useMemo(
    () =>
      [
        { value: 'date' as const, label: t('sortDate') },
        { value: 'votes' as const, label: t('sortVotes') },
      ].sort((a, b) => a.label.localeCompare(b.label)),
    [t]
  )

  const hasFilters =
    searchInput ||
    searchTerm ||
    typeFilter !== 'all' ||
    statusFilter ||
    sortFilter !== 'date'

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <AdminPageHeader
        eyebrow={`${tAdmin('title')} / ${tAdmin('feedback')}`}
        title={tAdmin('reviewFeedback')}
        actions={
          <span className="text-fl-hint text-fl-muted-4 self-center font-mono tracking-widest uppercase">
            {total} {tAdmin('total')}
          </span>
        }
      />

      <AdminNav />

      <div className="grid gap-3 md:grid-cols-3">
        <AdminMetric
          label={tAdmin('feedbackTotal')}
          value={total}
          icon={MessageSquareText}
        />
        <AdminMetric
          label={t('tabFeatures')}
          value={typeTotals.feature}
          icon={ThumbsUp}
        />
        <AdminMetric label={t('tabBugs')} value={typeTotals.bug} icon={Bug} />
      </div>

      {error && (
        <div className="border-fl-error/40 text-fl-error glass-card rounded-2xl border px-4 py-3 font-mono text-xs font-semibold">
          {error}
          <button
            onClick={() => setReload((value) => value + 1)}
            disabled={loading}
            className="neu-button ml-3 rounded-lg px-2.5 py-1 disabled:opacity-50"
          >
            {tCommon('retry')}
          </button>
        </div>
      )}

      <AdminPanel
        title={tAdmin('feedbackQueue')}
        meta={
          <div className="flex items-center gap-2">
            {loading && (
              <Loader2
                className="text-fl-accent size-3.5 animate-spin"
                aria-hidden="true"
              />
            )}
            <span className="text-fl-hint text-fl-muted-2 font-mono font-semibold tracking-widest uppercase">
              {entries.length} / {total}
            </span>
          </div>
        }
      >
        <div className="border-fl-border/60 grid gap-2 border-b px-5 py-3 lg:grid-cols-[minmax(14rem,1fr)_auto_auto_auto_auto]">
          <div className="flex min-w-0 gap-1.5">
            <input
              type="search"
              placeholder={tAdmin('feedbackSearchPlaceholder')}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearch()
              }}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              className="neu-input text-fl-fg placeholder:text-fl-muted-3 min-w-0 flex-1 rounded-xl px-4 py-2 font-mono text-xs font-medium transition-all focus:outline-none"
            />
            <button
              type="button"
              onClick={handleSearch}
              className="neu-button text-fl-fg inline-flex w-10 shrink-0 items-center justify-center rounded-xl transition-all"
              aria-label={tAdmin('feedbackSearchAction')}
            >
              <Search className="size-3.5" aria-hidden="true" />
            </button>
          </div>

          <select
            value={typeFilter}
            onChange={(e) => {
              setPage(0)
              setTypeFilter(e.target.value as TypeFilter)
            }}
            className="neu-input text-fl-fg appearance-none rounded-xl px-4 py-2 font-mono text-xs font-semibold transition-all focus:outline-none"
            aria-label={tAdmin('feedbackTypeFilter')}
          >
            {typeFilterOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={(e) => {
              setPage(0)
              setStatusFilter(e.target.value)
            }}
            className="neu-input text-fl-fg appearance-none rounded-xl px-4 py-2 font-mono text-xs font-semibold transition-all focus:outline-none"
            aria-label={t('filterStatus')}
          >
            {statusFilterOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <select
            value={sortFilter}
            onChange={(e) => {
              setPage(0)
              setSortFilter(e.target.value as SortFilter)
            }}
            className="neu-input text-fl-fg appearance-none rounded-xl px-4 py-2 font-mono text-xs font-semibold transition-all focus:outline-none"
            aria-label={t('sortBy')}
          >
            {sortFilterOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={clearFilters}
            disabled={!hasFilters}
            className="neu-button text-fl-label text-fl-fg inline-flex items-center justify-center gap-2 rounded-xl px-3.5 py-2 font-mono font-semibold tracking-widest uppercase transition-all disabled:cursor-not-allowed disabled:opacity-40"
          >
            <FilterX className="size-3.5" aria-hidden="true" />
            {tAdmin('clearFilters')}
          </button>
        </div>

        {loading && (
          <PageLoading
            fullScreen={false}
            label={tAdmin('loading')}
            className="p-4"
          />
        )}
        {entries.length === 0 ? (
          !loading &&
          !error && (
            <p className="text-fl-muted-2 px-6 py-10 text-center font-mono text-xs font-semibold">
              {hasFilters ? tAdmin('noFilteredFeedback') : t('noEntries')}
            </p>
          )
        ) : (
          <>
            <div className="hidden lg:block">
              <table className="w-full table-fixed border-collapse">
                <thead>
                  <tr className="border-fl-border/60 border-b">
                    <th className="text-fl-label text-fl-muted-2 w-[42%] px-5 py-3 text-left font-mono font-bold tracking-widest uppercase">
                      {tAdmin('feedbackItem')}
                    </th>
                    <th className="text-fl-label text-fl-muted-2 w-[13%] px-5 py-3 text-left font-mono font-bold tracking-widest uppercase">
                      {tAdmin('type')}
                    </th>
                    <th className="text-fl-label text-fl-muted-2 w-[18%] px-5 py-3 text-left font-mono font-bold tracking-widest uppercase">
                      {tAdmin('status')}
                    </th>
                    <th className="text-fl-label text-fl-muted-2 w-[13%] px-5 py-3 text-left font-mono font-bold tracking-widest uppercase">
                      {tAdmin('signals')}
                    </th>
                    <th className="text-fl-label text-fl-muted-2 w-[14%] px-5 py-3 text-right font-mono font-bold tracking-widest uppercase">
                      {tAdmin('actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr
                      key={entry.id}
                      className="border-fl-border/60 border-b transition-colors last:border-0 hover:bg-white/40 dark:hover:bg-white/5"
                    >
                      <td className="px-5 py-4 align-top">
                        <p className="text-fl-fg line-clamp-1 font-mono text-sm font-bold">
                          {entry.title}
                        </p>
                        <p className="text-fl-muted-2 mt-1 line-clamp-2 font-mono text-xs font-medium leading-relaxed">
                          {entry.description}
                        </p>
                        <p className="text-fl-label text-fl-muted-2 mt-2 flex flex-wrap items-center gap-x-1 font-mono font-medium">
                          <span>
                            {t('by')} {entry.author.display_name}
                          </span>
                          <AdminAuthorBadge role={entry.author.role} />
                          <span>· {formatDate(entry.created_at, locale)}</span>
                        </p>
                      </td>
                      <td className="px-5 py-4 align-top">
                        <AdminBadge
                          tone={entry.type === 'bug' ? 'danger' : 'neutral'}
                        >
                          {entry.type === 'feature'
                            ? t('tabFeatures')
                            : t('tabBugs')}
                        </AdminBadge>
                      </td>
                      <td className="px-5 py-4 align-top">
                        <div className="flex flex-col gap-2">
                          <AdminBadge
                            tone={
                              STATUS_TONES[entry.status] ?? STATUS_TONES.pending
                            }
                          >
                            {getStatusLabel(entry.status)}
                          </AdminBadge>
                          <select
                            value={entry.status}
                            onChange={(e) =>
                              handleStatusChange(entry, e.target.value)
                            }
                            disabled={
                              loading ||
                              savingStatus !== null ||
                              deletingId !== null
                            }
                            className="neu-input text-fl-fg appearance-none rounded-xl px-3 py-2 font-mono text-xs font-semibold transition-all focus:outline-none disabled:opacity-50"
                            aria-label={tAdmin('feedbackStatusAction')}
                          >
                            {feedbackStatusOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </td>
                      <td className="px-5 py-4 align-top">
                        <div className="text-fl-muted-2 space-y-2 font-mono text-xs font-semibold">
                          <p>▲ {entry.vote_count}</p>
                          <p>◌ {entry.comment_count}</p>
                        </div>
                      </td>
                      <td className="px-5 py-4 text-right align-top">
                        <button
                          onClick={() => setDeletePending(entry)}
                          disabled={
                            loading ||
                            savingStatus !== null ||
                            deletingId !== null
                          }
                          className="neu-button border-fl-error/30 text-fl-error-fg hover:text-fl-error inline-flex size-8 items-center justify-center rounded-xl transition-all disabled:opacity-40"
                          aria-label={tAdmin('delete')}
                          title={tAdmin('delete')}
                        >
                          {deletingId === entry.id ? (
                            <Loader2
                              className="size-3.5 animate-spin"
                              aria-hidden="true"
                            />
                          ) : (
                            <span className="text-xs font-bold leading-none">
                              X
                            </span>
                          )}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="lg:hidden">
              {entries.map((entry, i) => (
                <div
                  key={entry.id}
                  className={`space-y-3 px-4 py-4 ${i < entries.length - 1 ? 'border-fl-border/60 border-b' : ''}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <AdminBadge
                      tone={entry.type === 'bug' ? 'danger' : 'neutral'}
                    >
                      {entry.type === 'feature'
                        ? t('tabFeatures')
                        : t('tabBugs')}
                    </AdminBadge>
                    <AdminBadge
                      tone={STATUS_TONES[entry.status] ?? STATUS_TONES.pending}
                    >
                      {getStatusLabel(entry.status)}
                    </AdminBadge>
                  </div>

                  <div className="min-w-0">
                    <p className="text-fl-fg font-mono text-sm font-bold">
                      {entry.title}
                    </p>
                    <p className="text-fl-muted-2 mt-1 line-clamp-3 font-mono text-xs font-medium leading-relaxed">
                      {entry.description}
                    </p>
                    <p className="text-fl-label text-fl-muted-2 mt-2 flex flex-wrap items-center gap-x-1 font-mono font-medium">
                      <span>
                        {t('by')} {entry.author.display_name}
                      </span>
                      <AdminAuthorBadge role={entry.author.role} />
                      <span>· {formatDate(entry.created_at, locale)}</span>
                    </p>
                  </div>

                  <div className="text-fl-muted-2 flex flex-wrap items-center gap-3 font-mono text-xs font-semibold">
                    <span>▲ {entry.vote_count}</span>
                    <span>◌ {entry.comment_count}</span>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                    <select
                      value={entry.status}
                      onChange={(e) =>
                        handleStatusChange(entry, e.target.value)
                      }
                      disabled={
                        loading || savingStatus !== null || deletingId !== null
                      }
                      className="neu-input text-fl-fg appearance-none rounded-xl px-3 py-2 font-mono text-xs font-semibold transition-all focus:outline-none disabled:opacity-50"
                      aria-label={tAdmin('feedbackStatusAction')}
                    >
                      {feedbackStatusOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => setDeletePending(entry)}
                      disabled={
                        loading || savingStatus !== null || deletingId !== null
                      }
                      className="neu-button border-fl-error/30 text-fl-label text-fl-error-fg hover:text-fl-error inline-flex items-center justify-center gap-2 rounded-xl px-3.5 py-2 font-mono font-semibold tracking-widest uppercase transition-all disabled:opacity-40"
                    >
                      {deletingId === entry.id ? (
                        <Loader2
                          className="size-3.5 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      )}
                      {tAdmin('delete')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </AdminPanel>

      <Pagination
        page={page}
        totalPages={Math.ceil(total / PAGE_SIZE)}
        onPageChange={setPage}
        prevLabel={tAdmin('prevPage')}
        nextLabel={tAdmin('nextPage')}
      />

      <ConfirmDialog
        open={deletePending !== null}
        title={t('deleteEntryConfirmTitle')}
        message={t('deleteEntryConfirmMessage')}
        confirmLabel={t('deleteEntryConfirm')}
        danger
        confirming={deletingId !== null}
        onConfirm={() => deletePending && handleDelete(deletePending)}
        onCancel={() => setDeletePending(null)}
      />
    </div>
  )
}
