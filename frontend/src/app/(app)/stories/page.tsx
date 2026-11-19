'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { BookOpen, CheckCircle2, Lock } from 'lucide-react'
import { PageLoading } from '@/components/ui/page-loading'
import { TargetLanguageText } from '@/components/TargetLanguageText'
import { apiFetch } from '@/lib/api'
import { useLanguageStore } from '@/store/language'

type StoryState = 'locked' | 'available' | 'in_progress' | 'test_ready' | 'passed'

interface StorySummary {
  id: number
  title: string
  cefr_level: string
  paragraph_count: number
  state: StoryState
  current_paragraph: number
  best_score: number | null
}

interface StoryList {
  level: string
  pass_score: number
  paragraph_minutes: number
  stories: StorySummary[]
}

export default function StoriesPage() {
  const t = useTranslations('stories')
  const tCommon = useTranslations('common')
  const activeLanguage = useLanguageStore((s) => s.activeLanguage)
  const [data, setData] = useState<StoryList | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setFailed(false)
    apiFetch('/api/stories', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error()
        return res.json()
      })
      .then((json: StoryList) => setData(json))
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
  }, [activeLanguage?.code, attempt])

  if (failed) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 p-6">
        <p role="alert" className="text-fl-muted-1 font-sans text-sm">
          {t('loadError')}
        </p>
        <button
          type="button"
          className="text-fl-accent font-sans text-sm underline"
          onClick={() => setAttempt((n) => n + 1)}
        >
          {tCommon('retry')}
        </button>
      </div>
    )
  }
  if (!data) return <PageLoading />

  const levels = Array.from(new Set(data.stories.map((s) => s.cefr_level)))

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="space-y-2">
        <p className="text-fl-muted-2 font-mono text-xs tracking-widest uppercase">
          {t('eyebrow')}
        </p>
        <h1 className="text-fl-fg font-sans text-2xl font-bold">{t('title')}</h1>
        <p className="text-fl-muted-1 font-sans text-sm">
          {t('intro', {
            minutes: data.paragraph_minutes,
            pass: data.pass_score,
          })}
        </p>
        <p className="text-fl-fg font-mono text-sm">
          {t('yourLevel')}: <span className="font-bold">{data.level}</span>
        </p>
      </header>

      {data.stories.length === 0 ? (
        <p className="text-fl-muted-1 font-sans text-sm">{t('empty')}</p>
      ) : (
        levels.map((level) => (
          <section key={level} className="space-y-3">
            <h2 className="text-fl-muted-2 font-mono text-xs font-bold tracking-widest uppercase">
              {t('levelHeading', { level })}
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2">
              {data.stories
                .filter((s) => s.cefr_level === level)
                .map((story) => (
                  <StoryCard
                    key={story.id}
                    story={story}
                    languageCode={activeLanguage?.code}
                  />
                ))}
            </ul>
          </section>
        ))
      )}
    </div>
  )
}

function StoryCard({
  story,
  languageCode,
}: {
  story: StorySummary
  languageCode?: string
}) {
  const t = useTranslations('stories')
  const locked = story.state === 'locked'
  return (
    <li
      className={`glass-card flex flex-col gap-3 rounded-2xl p-4 ${locked ? 'opacity-60' : ''}`}
    >
      <div className="flex items-start gap-3">
        {locked ? (
          <Lock className="text-fl-muted-2 mt-0.5 size-5 shrink-0" aria-hidden="true" />
        ) : story.state === 'passed' ? (
          <CheckCircle2 className="text-fl-accent mt-0.5 size-5 shrink-0" aria-hidden="true" />
        ) : (
          <BookOpen className="text-fl-accent mt-0.5 size-5 shrink-0" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <TargetLanguageText
            as="p"
            languageCode={languageCode}
            className="text-fl-fg font-semibold"
          >
            {story.title}
          </TargetLanguageText>
          <p className="text-fl-muted-2 font-sans text-xs">
            {t(`state_${story.state}`)} ·{' '}
            {t('paragraphCount', { count: story.paragraph_count })}
            {story.best_score !== null && ` · ${t('bestScore', { score: story.best_score })}`}
          </p>
        </div>
      </div>
      {!locked && (
        <div className="flex flex-wrap gap-2">
          {story.state !== 'test_ready' && (
            <Link
              href={`/stories/${story.id}`}
              className="neu-button-primary rounded-xl px-4 py-2 font-mono text-xs font-bold tracking-widest uppercase"
            >
              {story.state === 'available'
                ? t('start')
                : story.state === 'passed'
                  ? t('replay')
                  : t('continue')}
            </Link>
          )}
          {(story.state === 'test_ready' || story.state === 'passed') && (
            <Link
              href={`/stories/${story.id}/test`}
              className={`${story.state === 'test_ready' ? 'neu-button-primary' : 'neu-button'} rounded-xl px-4 py-2 font-mono text-xs font-bold tracking-widest uppercase`}
            >
              {story.state === 'passed' ? t('retakeTest') : t('takeTest')}
            </Link>
          )}
        </div>
      )}
    </li>
  )
}
