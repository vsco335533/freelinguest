'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

import { useLocale, useTranslations } from 'next-intl'
import { PageLoading } from '@/components/ui/page-loading'
import { apiFetch } from '@/lib/api'
import { useLanguageStore } from '@/store/language'
import NoPlanBanner from '@/components/plan/NoPlanBanner'
import {
  getCurriculumUnits,
  type CurriculumUnit,
  type CEFRLevel,
} from '@/data/curriculum'
import type { VocabularySet } from '@/data/types'
import { Check, Circle, CircleDashed } from 'lucide-react'
import {
  ProgressOverview,
  type ActivityDay,
} from '@/components/dashboard/ProgressOverview'
import {
  ActivityHistory,
  type ProgressHistoryEntry,
} from '@/components/progress/ActivityHistory'
import { RewardGuide } from '@/components/progress/RewardGuide'
import { TargetLanguageText } from '@/components/TargetLanguageText'
import { useAnalyticsView } from '@/hooks/useAnalyticsView'
import { localizeChecklistItem, localizeUnitTitle } from '@/lib/curriculum-i18n'

// ── Types ──────────────────────────────────────────────────────────────────────

interface CompetencyRecord {
  unit_id: string
  score: number // 0–1 average
  mastered_count: number
  total_count: number
}

interface ProgressSummary {
  total_xp: number
  current_streak: number
  total_lessons: number
  total_exercises: number
  exercises_correct: number
  accuracy: number
  skills: Record<string, number>
  today_xp: number
  activity_week: ActivityDay[]
}

interface FlashcardProgress {
  id: number
  word: string
  repetitions: number
}

interface StudyPlan {
  id: number
  cefr_level: string
}

type CompetencyStatus = 'mastered' | 'in-progress' | 'not-started'

// ── Helpers ────────────────────────────────────────────────────────────────────

function getCompetencyStatus(
  itemIndex: number,
  masteredCount: number,
  totalCount: number,
  score: number
): CompetencyStatus {
  if (itemIndex < masteredCount) return 'mastered'
  if (score > 0 && itemIndex < totalCount) return 'in-progress'
  return 'not-started'
}

const STATUS_ICON = {
  mastered: Check,
  'in-progress': CircleDashed,
  'not-started': Circle,
}

const STATUS_LABEL = {
  mastered: 'mastered',
  'in-progress': 'inProgress',
  'not-started': 'notStarted',
}

const STATUS_COLOR: Record<CompetencyStatus, string> = {
  mastered: 'text-fl-fg',
  'in-progress': 'text-amber-600 dark:text-amber-400',
  'not-started': 'text-fl-muted-4',
}

// ── Sub-components ────────────────────────────────────────────────────────────

function UnitCompetencyBlock({
  unit,
  record,
  languageCode,
}: {
  unit: CurriculumUnit
  record: CompetencyRecord | undefined
  languageCode: string
}) {
  const t = useTranslations('progress')
  const tPlan = useTranslations('plan')
  const tCommon = useTranslations('common')
  const locale = useLocale()
  const number = new Intl.NumberFormat(locale)
  const masteredCount = record?.mastered_count ?? 0
  const totalCount = unit.competency_checklist.length
  const score = record?.score ?? 0
  const pct =
    totalCount > 0 ? Math.round((masteredCount / totalCount) * 100) : 0
  const unitTitle = localizeUnitTitle(
    {
      unitId: unit.id,
      title: unit.title,
      cefrLevel: unit.level,
      targetLanguage: languageCode,
    },
    tCommon
  )
  const isLocalizedUnitTitle = unitTitle !== unit.title

  return (
    <div className="glass-card overflow-hidden rounded-2xl">
      {/* Unit header */}
      <div className="border-fl-border/60 flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0 space-y-1">
          <span className="text-fl-muted-2 text-xs font-semibold">
            {tPlan('unitLabel')} {number.format(unit.unit_number)}
          </span>
          {isLocalizedUnitTitle ? (
            <h3 lang={locale} className="text-fl-fg font-semibold">
              {unitTitle}
            </h3>
          ) : (
            <TargetLanguageText
              as="h3"
              languageCode={languageCode}
              className="text-fl-fg font-semibold"
            >
              {unitTitle}
            </TargetLanguageText>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-fl-muted-2 text-xs font-semibold tabular-nums">
            {number.format(masteredCount)}/{number.format(totalCount)}{' '}
            {t('mastered')}
          </span>
          {record && (
            <span className="text-fl-muted-2 text-xs font-semibold tabular-nums">
              {number.format(Math.round(score * 100))}%
            </span>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div
        className="bg-fl-border/60 h-1.5 w-full overflow-hidden rounded-full"
        role="progressbar"
        aria-label={`${unitTitle}: ${t('mastered')}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div
          className="bg-fl-accent h-full transition-[width] motion-reduce:transition-none"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Competency list */}
      <ul className="space-y-2 px-5 py-3">
        {unit.competency_checklist.map((text, idx) => {
          const status = getCompetencyStatus(
            idx,
            masteredCount,
            record?.total_count ?? 0,
            score
          )
          const Icon = STATUS_ICON[status]
          const localizedText = localizeChecklistItem(
            {
              unitId: unit.id,
              index: idx,
              text,
              targetLanguage: languageCode,
            },
            tCommon
          )
          const isLocalizedItem = localizedText !== text
          return (
            <li key={idx} className="flex items-start gap-3">
              <span className={`mt-0.5 shrink-0 ${STATUS_COLOR[status]}`}>
                <Icon className="size-4" aria-hidden="true" />
                <span className="sr-only">{t(STATUS_LABEL[status])}: </span>
              </span>
              {isLocalizedItem ? (
                <span lang={locale} className={STATUS_COLOR[status]}>
                  {localizedText}
                </span>
              ) : (
                <TargetLanguageText
                  languageCode={languageCode}
                  className={STATUS_COLOR[status]}
                >
                  {text}
                </TargetLanguageText>
              )}
              {status === 'in-progress' && record && (
                <span className="text-fl-muted-2 ml-auto shrink-0 text-xs tabular-nums">
                  {number.format(Math.round(score * 100))}%
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ProgressPage() {
  const t = useTranslations('progress')
  const tTarget = useTranslations('targetLanguages')
  const activeLanguage = useLanguageStore((s) => s.activeLanguage)
  const needsRefresh = useLanguageStore((s) => s.needsRefresh)
  const isSwitching = useLanguageStore((s) => s.isSwitching)

  // Unmount the old content even if a failed reconciliation preserves its code.
  if (isSwitching) return <PageLoading label={t('loading')} />
  if (needsRefresh || !activeLanguage) return <ProgressLanguageRecovery />

  const localizedLanguageName = tTarget.has(activeLanguage.code)
    ? tTarget(activeLanguage.code)
    : activeLanguage.name

  return (
    <ProgressContent
      key={activeLanguage.code}
      targetLanguageCode={activeLanguage.code}
      languageName={localizedLanguageName}
    />
  )
}

function ProgressLoadError({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('common')
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6 text-center">
      <p role="alert" className="text-fl-muted-1">
        {t('errorMessage')}
      </p>
      <button
        className="neu-button text-fl-fg rounded-xl px-5 py-2.5 text-sm font-semibold"
        onClick={onRetry}
      >
        {t('retry')}
      </button>
    </div>
  )
}

function ProgressLanguageRecovery() {
  const t = useTranslations('progress')
  const fetchLanguages = useLanguageStore((s) => s.fetchLanguages)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    void fetchLanguages(controller.signal).then((ok) => {
      if (cancelled) return
      setFailed(!ok)
      setLoading(false)
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [fetchLanguages, attempt])

  if (loading) return <PageLoading label={t('loading')} />
  if (failed) {
    return (
      <ProgressLoadError
        onRetry={() => {
          setLoading(true)
          setAttempt((value) => value + 1)
        }}
      />
    )
  }
  return <NoPlanBanner />
}

interface ProgressData {
  summary: ProgressSummary
  competencies: CompetencyRecord[]
  plan: StudyPlan
  flashcards: FlashcardProgress[]
  levelUnits: CurriculumUnit[]
  vocabSets: VocabularySet[]
  history: ProgressHistoryEntry[]
}

function ProgressContent({
  targetLanguageCode,
  languageName,
}: {
  targetLanguageCode: string
  languageName?: string
}) {
  const locale = useLocale()
  const skillsAnalyticsRef = useAnalyticsView('progress_skills_viewed')
  const t = useTranslations('progress')
  const tVocab = useTranslations('vocabulary')
  const tDashboard = useTranslations('dashboard')
  const tPlan = useTranslations('plan')
  const [data, setData] = useState<ProgressData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [showAllLevels, setShowAllLevels] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [sumRes, compRes, planRes, flashRes, historyRes, vocabRes] =
          await Promise.all([
            apiFetch('/api/progress/summary'),
            apiFetch('/api/progress/competencies'),
            apiFetch('/api/study-plan/current'),
            apiFetch('/api/flashcards/all'),
            apiFetch('/api/progress/history'),
            apiFetch(
              `/api/vocabulary?language=${encodeURIComponent(targetLanguageCode)}`
            ),
          ])
        if (cancelled) return
        if (!planRes.ok) throw new Error('Could not load study plan')
        const plan = (await planRes.json()) as StudyPlan | null
        if (cancelled || !plan) return
        if (
          [sumRes, compRes, flashRes, historyRes, vocabRes].some(
            (res) => !res.ok
          )
        ) {
          throw new Error('Could not load progress')
        }
        const [summary, competencies, flashcards, history, vocabulary] =
          await Promise.all([
            sumRes.json() as Promise<ProgressSummary>,
            compRes.json() as Promise<CompetencyRecord[]>,
            flashRes.json() as Promise<FlashcardProgress[]>,
            historyRes.json() as Promise<{ entries: ProgressHistoryEntry[] }>,
            vocabRes.json() as Promise<{ sets: VocabularySet[] }>,
          ])
        if (cancelled) return
        const levelUnits = await getCurriculumUnits(
          plan.cefr_level,
          targetLanguageCode
        )
        if (cancelled) return
        setData({
          summary,
          competencies,
          plan,
          flashcards,
          levelUnits,
          vocabSets: vocabulary.sets,
          history: history.entries,
        })
      } catch {
        if (!cancelled) setLoadError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [targetLanguageCode, retry])

  if (loading) {
    return <PageLoading label={t('loading')} />
  }

  if (loadError) {
    return (
      <ProgressLoadError
        onRetry={() => {
          setLoadError(false)
          setLoading(true)
          setRetry((value) => value + 1)
        }}
      />
    )
  }

  if (!data) {
    return <NoPlanBanner />
  }

  const {
    summary,
    competencies,
    plan,
    flashcards,
    levelUnits,
    vocabSets,
    history,
  } = data
  const compMap = Object.fromEntries(competencies.map((c) => [c.unit_id, c]))
  const cefrLevel = plan.cefr_level as CEFRLevel
  const displayVocabSets = showAllLevels
    ? vocabSets
    : vocabSets.filter((s) => s.level === cefrLevel)
  const totalDisplayWords = displayVocabSets.reduce(
    (a, s) => a + s.words.length,
    0
  )

  const masteredWordSet = new Set(
    flashcards
      .filter((f) => f.repetitions > 0)
      .map((f) => f.word.trim().toLowerCase())
  )
  const totalMastered = displayVocabSets.reduce(
    (a, s) =>
      a +
      s.words.filter((w) => masteredWordSet.has(w.word.trim().toLowerCase()))
        .length,
    0
  )
  const today = summary.activity_week.at(-1)?.date

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-fl-fg text-2xl font-bold">{t('title')}</h1>
        {languageName && (
          <span className="glass-card text-fl-muted-1 rounded-full px-3.5 py-1.5 text-sm font-semibold">
            {languageName} · {cefrLevel}
          </span>
        )}
      </div>

      <ProgressOverview
        xp={summary.total_xp}
        todayXp={summary.today_xp}
        streak={summary.current_streak}
        activity={summary.activity_week}
        lessons={summary.total_lessons}
        correct={summary.exercises_correct}
        total={summary.total_exercises}
        showDetails={false}
      />
      {today && <ActivityHistory entries={history} endDate={today} />}
      <RewardGuide />

      {/* Grammar Competencies */}
      {levelUnits.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <h2 className="text-fl-fg text-lg font-semibold">
              {cefrLevel
                ? t('competenciesSection', { level: cefrLevel })
                : t('competencies')}
            </h2>
            <div className="bg-fl-border h-px flex-1" />
          </div>

          {levelUnits.map((unit) => (
            <UnitCompetencyBlock
              key={unit.id}
              unit={unit}
              record={compMap[unit.id]}
              languageCode={targetLanguageCode}
            />
          ))}

          {competencies.length === 0 && (
            <div className="glass-card rounded-2xl px-6 py-8 text-center">
              <p className="text-fl-muted-2 text-sm leading-relaxed font-medium">
                {t('noCompetencies')}
              </p>
              <Link
                href="/plan"
                className="text-fl-accent mt-4 inline-block text-sm font-semibold hover:underline"
              >
                {t('goToMyPlan')}
              </Link>
            </div>
          )}
        </section>
      )}

      {/* Vocabulary Progress */}
      {displayVocabSets.length > 0 && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-fl-fg text-lg font-semibold">
              {showAllLevels
                ? t('vocabularySection')
                : cefrLevel
                  ? t('vocabularyHeader', { level: cefrLevel })
                  : t('vocabularySection')}
            </h2>
            <div className="bg-fl-border h-px flex-1" />
            <span className="text-fl-muted-2 text-sm tabular-nums">
              {totalMastered.toLocaleString(locale)}/
              {totalDisplayWords.toLocaleString(locale)} {tVocab('words')}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAllLevels(false)}
              aria-pressed={!showAllLevels}
              className={`rounded-xl px-3.5 py-2 text-sm font-semibold transition-all ${
                !showAllLevels
                  ? 'neu-button-primary text-white'
                  : 'neu-button text-fl-muted-2 hover:text-fl-fg'
              }`}
            >
              {t('currentLevelOnly')}
            </button>
            <button
              onClick={() => setShowAllLevels(true)}
              aria-pressed={showAllLevels}
              className={`rounded-xl px-3.5 py-2 text-sm font-semibold transition-all ${
                showAllLevels
                  ? 'neu-button-primary text-white'
                  : 'neu-button text-fl-muted-2 hover:text-fl-fg'
              }`}
            >
              {t('allLevels')}
            </button>
          </div>

          <div className="glass-card divide-fl-border/60 divide-y overflow-hidden rounded-2xl">
            {displayVocabSets.map((s) => {
              const mastered = s.words.filter((w) =>
                masteredWordSet.has(w.word.trim().toLowerCase())
              ).length
              const pct =
                s.words.length > 0
                  ? Math.round((mastered / s.words.length) * 100)
                  : 0
              return (
                <div key={s.id} className="flex items-center gap-4 px-5 py-3">
                  <Link
                    href={`/vocabulary/${s.id}`}
                    className="text-fl-muted-1 hover:text-fl-fg min-w-0 flex-1 truncate text-sm font-medium transition-colors"
                  >
                    <TargetLanguageText languageCode={targetLanguageCode}>
                      {s.topic}
                    </TargetLanguageText>
                  </Link>
                  <div className="flex items-center gap-3">
                    <div
                      className="bg-fl-border/60 h-1.5 w-16 overflow-hidden rounded-full sm:w-24"
                      role="progressbar"
                      aria-label={s.topic}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={pct}
                    >
                      <div
                        className="bg-fl-accent h-full rounded-full transition-[width] motion-reduce:transition-none"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-fl-muted-2 min-w-12 text-right text-xs font-semibold tabular-nums">
                      {mastered.toLocaleString(locale)}/
                      {s.words.length.toLocaleString(locale)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Skills breakdown */}
      {summary && Object.keys(summary.skills).length > 0 && (
        <section ref={skillsAnalyticsRef} className="space-y-4">
          <div className="flex items-center gap-3">
            <h2 className="text-fl-fg text-lg font-semibold">
              {tDashboard('recentPerformance')}
            </h2>
            <div className="bg-fl-border h-px flex-1" />
          </div>
          <p className="text-fl-muted-2 text-sm font-medium">
            {tDashboard('recentPerformanceDescription')}
          </p>
          <div className="glass-card divide-fl-border/60 divide-y overflow-hidden rounded-2xl">
            {Object.entries(summary.skills).map(([skill, value]) => (
              <div key={skill} className="flex items-center gap-4 px-5 py-3">
                <span className="text-fl-muted-1 w-28 text-sm font-medium">
                  {tPlan.has(`lessonTypes.${skill}`)
                    ? tPlan(`lessonTypes.${skill}`)
                    : skill}
                </span>
                <div
                  className="bg-fl-border/60 h-1.5 flex-1 overflow-hidden rounded-full"
                  role="progressbar"
                  aria-label={
                    tPlan.has(`lessonTypes.${skill}`)
                      ? tPlan(`lessonTypes.${skill}`)
                      : skill
                  }
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(value * 100)}
                >
                  <div
                    className="bg-fl-accent h-full"
                    style={{ width: `${Math.round(value * 100)}%` }}
                  />
                </div>
                <span className="text-fl-muted-2 w-10 text-right text-xs tabular-nums">
                  {Math.round(value * 100).toLocaleString(locale)}%
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
