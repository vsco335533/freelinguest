'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { AdminNav } from '@/components/admin/AdminNav'
import {
  AdminBadge,
  AdminPageHeader,
  AdminPanel,
} from '@/components/admin/AdminShell'
import { apiFetch } from '@/lib/api'

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const
const LANGUAGES = ['en-GB', 'en-US'] as const

interface StorySummary {
  id: number
  title: string
  target_language: string
  cefr_level: string
  position: number
  is_published: boolean
  paragraph_count: number
}

interface StoryDraft {
  id: number | null
  title: string
  target_language: string
  cefr_level: string
  position: number
  is_published: boolean
  paragraphs: string[]
}

const EMPTY_DRAFT: StoryDraft = {
  id: null,
  title: '',
  target_language: 'en-GB',
  cefr_level: 'A1',
  position: 0,
  is_published: false,
  paragraphs: [''],
}

const inputClass =
  'border-fl-border bg-fl-bg text-fl-fg w-full rounded-xl border px-3 py-2 font-sans text-sm'

export default function AdminStoriesPage() {
  const t = useTranslations('admin')
  const [stories, setStories] = useState<StorySummary[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<StoryDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch('/api/admin/stories')
      if (res.ok) setStories(await res.json())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function edit(id: number) {
    setMessage('')
    const res = await apiFetch(`/api/admin/stories/${id}`)
    if (!res.ok) return setMessage(t('storyLoadError'))
    const data = await res.json()
    setDraft({ ...data, paragraphs: data.paragraphs.length ? data.paragraphs : [''] })
  }

  function update(patch: Partial<StoryDraft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current))
  }

  function updateParagraph(index: number, text: string) {
    setDraft((current) =>
      current
        ? {
            ...current,
            paragraphs: current.paragraphs.map((p, i) => (i === index ? text : p)),
          }
        : current
    )
  }

  function moveParagraph(index: number, delta: number) {
    setDraft((current) => {
      if (!current) return current
      const target = index + delta
      if (target < 0 || target >= current.paragraphs.length) return current
      const paragraphs = [...current.paragraphs]
      ;[paragraphs[index], paragraphs[target]] = [paragraphs[target], paragraphs[index]]
      return { ...current, paragraphs }
    })
  }

  function removeParagraph(index: number) {
    setDraft((current) =>
      current
        ? {
            ...current,
            paragraphs:
              current.paragraphs.length > 1
                ? current.paragraphs.filter((_, i) => i !== index)
                : [''],
          }
        : current
    )
  }

  async function save() {
    if (!draft) return
    const paragraphs = draft.paragraphs.map((p) => p.trim()).filter(Boolean)
    if (!draft.title.trim() || paragraphs.length === 0) {
      return setMessage(t('storyRequired'))
    }
    setSaving(true)
    setMessage('')
    try {
      const body = JSON.stringify({ ...draft, id: undefined, paragraphs })
      const res = await apiFetch(
        draft.id ? `/api/admin/stories/${draft.id}` : '/api/admin/stories',
        {
          method: draft.id ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }
      )
      if (!res.ok) return setMessage(t('storySaveError'))
      const saved = await res.json()
      setDraft({ ...saved })
      setMessage(t('storySaved'))
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function remove(id: number) {
    if (!window.confirm(t('storyDeleteConfirm'))) return
    const res = await apiFetch(`/api/admin/stories/${id}`, { method: 'DELETE' })
    if (res.ok) {
      if (draft?.id === id) setDraft(null)
      await load()
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <AdminPageHeader
        eyebrow={`${t('title')} / ${t('stories')}`}
        title={t('stories')}
        actions={
          <button
            type="button"
            className="neu-button-primary flex items-center gap-2 rounded-xl px-4 py-2 font-mono text-xs font-bold tracking-widest uppercase"
            onClick={() => {
              setMessage('')
              setDraft({ ...EMPTY_DRAFT, paragraphs: [''] })
            }}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {t('storyNew')}
          </button>
        }
      />
      <AdminNav />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <AdminPanel title={t('storyList')}>
          {loading ? (
            <p className="text-fl-muted-2 p-5 text-sm">{t('loading')}</p>
          ) : stories.length === 0 ? (
            <p className="text-fl-muted-2 p-5 text-sm">{t('storyEmpty')}</p>
          ) : (
            <ul className="divide-fl-border/60 divide-y">
              {stories.map((story) => (
                <li key={story.id} className="flex items-center gap-3 px-5 py-3">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => void edit(story.id)}
                  >
                    <p className="text-fl-fg truncate font-sans text-sm font-semibold">
                      {story.title}
                    </p>
                    <p className="text-fl-muted-2 font-mono text-xs">
                      {story.cefr_level} · {story.target_language} ·{' '}
                      {t('storyParagraphCount', { count: story.paragraph_count })}
                    </p>
                  </button>
                  <AdminBadge tone={story.is_published ? 'success' : 'neutral'}>
                    {story.is_published ? t('storyPublished') : t('storyDraft')}
                  </AdminBadge>
                  <button
                    type="button"
                    aria-label={t('storyDelete')}
                    className="text-fl-muted-2 hover:text-fl-error p-1"
                    onClick={() => void remove(story.id)}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </AdminPanel>

        <AdminPanel title={draft?.id ? t('storyEdit') : t('storyNew')}>
          {!draft ? (
            <p className="text-fl-muted-2 p-5 text-sm">{t('storySelectHint')}</p>
          ) : (
            <div className="space-y-4 p-5">
              <label className="block space-y-1">
                <span className="text-fl-muted-2 font-mono text-xs uppercase">
                  {t('storyTitle')}
                </span>
                <input
                  className={inputClass}
                  value={draft.title}
                  maxLength={200}
                  onChange={(e) => update({ title: e.target.value })}
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block space-y-1">
                  <span className="text-fl-muted-2 font-mono text-xs uppercase">
                    {t('storyLevel')}
                  </span>
                  <select
                    className={inputClass}
                    value={draft.cefr_level}
                    onChange={(e) => update({ cefr_level: e.target.value })}
                  >
                    {LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1">
                  <span className="text-fl-muted-2 font-mono text-xs uppercase">
                    {t('storyLanguage')}
                  </span>
                  <select
                    className={inputClass}
                    value={draft.target_language}
                    onChange={(e) => update({ target_language: e.target.value })}
                  >
                    {LANGUAGES.map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1">
                  <span className="text-fl-muted-2 font-mono text-xs uppercase">
                    {t('storyOrder')}
                  </span>
                  <input
                    type="number"
                    min={0}
                    className={inputClass}
                    value={draft.position}
                    onChange={(e) =>
                      update({ position: Math.max(0, Number(e.target.value) || 0) })
                    }
                  />
                </label>
              </div>

              <div className="space-y-3">
                {draft.paragraphs.map((paragraph, index) => (
                  <div key={index} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-fl-muted-2 flex-1 font-mono text-xs uppercase">
                        {t('storyParagraph', { number: index + 1 })}
                      </span>
                      <button
                        type="button"
                        aria-label={t('storyMoveUp')}
                        className="text-fl-muted-2 hover:text-fl-fg p-1 disabled:opacity-30"
                        disabled={index === 0}
                        onClick={() => moveParagraph(index, -1)}
                      >
                        <ArrowUp className="size-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label={t('storyMoveDown')}
                        className="text-fl-muted-2 hover:text-fl-fg p-1 disabled:opacity-30"
                        disabled={index === draft.paragraphs.length - 1}
                        onClick={() => moveParagraph(index, 1)}
                      >
                        <ArrowDown className="size-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label={t('storyRemoveParagraph')}
                        className="text-fl-muted-2 hover:text-fl-error p-1"
                        onClick={() => removeParagraph(index)}
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </button>
                    </div>
                    <textarea
                      className={`${inputClass} min-h-28`}
                      value={paragraph}
                      maxLength={3000}
                      onChange={(e) => updateParagraph(index, e.target.value)}
                    />
                  </div>
                ))}
                <button
                  type="button"
                  className="neu-button flex items-center gap-2 rounded-xl px-4 py-2 font-mono text-xs font-bold tracking-widest uppercase"
                  onClick={() =>
                    update({ paragraphs: [...draft.paragraphs, ''] })
                  }
                >
                  <Plus className="size-3.5" aria-hidden="true" />
                  {t('storyAddParagraph')}
                </button>
              </div>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.is_published}
                  onChange={(e) => update({ is_published: e.target.checked })}
                />
                <span className="text-fl-fg font-sans text-sm">
                  {t('storyPublishLabel')}
                </span>
              </label>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={saving}
                  className="neu-button-primary rounded-xl px-5 py-2 font-mono text-xs font-bold tracking-widest uppercase disabled:opacity-50"
                  onClick={() => void save()}
                >
                  {saving ? t('loading') : t('storySave')}
                </button>
                {message && (
                  <p role="status" className="text-fl-muted-1 font-sans text-sm">
                    {message}
                  </p>
                )}
              </div>
            </div>
          )}
        </AdminPanel>
      </div>
    </div>
  )
}
