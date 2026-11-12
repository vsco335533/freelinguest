'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Check } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useBillingPortal } from '@/hooks/useBillingPortal'
import { trackDashboardLink } from '@/lib/analytics'
import { localizeLessonTitle } from '@/lib/curriculum-i18n'
import {
  isSubscribed,
  needsPaymentRecovery,
  isFreemiumTrialActive,
  useAuthStore,
} from '@/store/auth'
import { useProgressStore } from '@/store/progress'
import { useLanguageStore } from '@/store/language'
import { useConfigStore } from '@/store/config'
import OnboardingTour from '@/components/tour/OnboardingTour'
import WhatsNew from '@/components/whats-new/WhatsNew'
import { PageLoading } from '@/components/ui/page-loading'
import { SubscriptionPlanButtons } from '@/components/billing/SubscriptionPlanButtons'
import { DashboardAnnouncement } from '@/components/dashboard/DashboardAnnouncement'
import {
  ProgressOverview,
  type ActivityDay,
} from '@/components/dashboard/ProgressOverview'

interface TodayLessonItem {
  id: number | null
  title: string
  lesson_type: string
  week: number
  day: number
  objectives: string[]
  estimated_minutes: number
  unit_id?: string
  is_completed: boolean
}

interface CompletionState {
  state: 'in_progress' | 'ready' | 'taken'
  score: number | null
  recommendation: string | null
  next_level: string | null
}

export default function DashboardPage() {
  const t = useTranslations('dashboard')
  const tCommon = useTranslations('common')
  const tLang = useTranslations('languages')
  const tAssessment = useTranslations('assessment')
  const tBilling = useTranslations('billing')
  const tNav = useTranslations('nav')
  const tPlan = useTranslations('plan')
  const tTarget = useTranslations('targetLanguages')
  const tError = useTranslations('error')
  const user = useAuthStore((s) => s.user)
  const stripeEnabled = useConfigStore((s) => s.stripeEnabled)
  const freemiumTrialActive = isFreemiumTrialActive(user, stripeEnabled)

  const {
    streak,
    xp,
    skills,
    todayLessons,
    completedToday,
    setProgress,
    setTodayLessons,
  } = useProgressStore()
  const activeLanguage = useLanguageStore((s) => s.activeLanguage)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [hasPlan, setHasPlan] = useState(false)
  const [planId, setPlanId] = useState<number | null>(null)
  const [completion, setCompletion] = useState<CompletionState | null>(null)
  const [cefrLevel, setCefrLevel] = useState<string | null>(null)
  const [progressDay, setProgressDay] = useState(0)
  const [totalDays, setTotalDays] = useState(0)
  const [pendingCount, setPendingCount] = useState(0)
  const [totalLessons, setTotalLessons] = useState(0)
  const [totalExercises, setTotalExercises] = useState(0)
  const [exercisesCorrect, setExercisesCorrect] = useState(0)
  const [todayXp, setTodayXp] = useState(0)
  const [activityWeek, setActivityWeek] = useState<ActivityDay[]>([])
  const loadSequence = useRef(0)
  const [vocabularyLevel, setVocabularyLevel] = useState<string | null>(null)
  const [vocabularyMastered, setVocabularyMastered] = useState(0)
  const [vocabularyTotal, setVocabularyTotal] = useState(0)
  const [vocabularyProgress, setVocabularyProgress] = useState(0)
  const [skipping, setSkipping] = useState(false)
  const [skipError, setSkipError] = useState(false)
  const {
    openPortal,
    loading: portalLoading,
    error: portalError,
  } = useBillingPortal()

  const loadData = useCallback(async () => {
    const sequence = ++loadSequence.current
    try {
      const [progRes, planRes] = await Promise.all([
        apiFetch('/api/progress/summary'),
        apiFetch('/api/study-plan/today'),
      ])
      if (sequence !== loadSequence.current) return
      const prog = progRes.ok ? await progRes.json() : null
      const plan = planRes.ok ? await planRes.json() : null
      if (sequence !== loadSequence.current) return
      if (progRes.ok) {
        setProgress({
          streak: prog.current_streak ?? 0,
          xp: prog.total_xp ?? 0,
          skills: prog.skills ?? {},
        })
        setTotalLessons(prog.total_lessons ?? 0)
        setTotalExercises(prog.total_exercises ?? 0)
        setExercisesCorrect(prog.exercises_correct ?? 0)
        setTodayXp(prog.today_xp ?? 0)
        setActivityWeek(prog.activity_week ?? [])
        setVocabularyLevel(prog.vocabulary_level ?? null)
        setVocabularyMastered(prog.vocabulary_mastered ?? 0)
        setVocabularyTotal(prog.vocabulary_total ?? 0)
        setVocabularyProgress(prog.vocabulary_progress ?? 0)
      } else {
        setProgress({ streak: 0, xp: 0, skills: {} })
        setTotalLessons(0)
        setTotalExercises(0)
        setExercisesCorrect(0)
        setTodayXp(0)
        setActivityWeek([])
        setVocabularyLevel(null)
        setVocabularyMastered(0)
        setVocabularyTotal(0)
        setVocabularyProgress(0)
      }
      if (planRes.ok) {
        setCefrLevel(plan.cefr_level ?? null)
        setPlanId(plan.plan_id ?? null)
        setCompletion(plan.completion ?? null)
        setProgressDay(plan.progress_day ?? 0)
        setTotalDays(plan.total_days ?? 0)
        setPendingCount(plan.pending_count ?? 0)
        setTodayLessons(
          plan.lessons.map((l: TodayLessonItem) => ({
            id: l.id,
            title: l.title,
            lessonType: l.lesson_type,
            week: l.week,
            day: l.day,
            objectives: l.objectives || [],
            estimatedMinutes: l.estimated_minutes || 25,
            unitId: l.unit_id,
            isCompleted: l.is_completed,
          }))
        )
        setHasPlan(true)
      } else {
        setCefrLevel(null)
        setPlanId(null)
        setCompletion(null)
        setProgressDay(0)
        setTotalDays(0)
        setPendingCount(0)
        setTodayLessons([])
        setHasPlan(false)
      }
    } catch {
      if (sequence === loadSequence.current) setLoadError(true)
    } finally {
      if (sequence === loadSequence.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-fetch when active language changes
  }, [setProgress, setTodayLessons, activeLanguage?.code])

  useEffect(() => {
    setLoading(true)
    setLoadError(false)
    loadData()
    return () => {
      loadSequence.current += 1
    }
  }, [loadData])

  async function skipDay() {
    if (skipping) return
    setSkipping(true)
    try {
      await apiFetch('/api/study-plan/skip-day', { method: 'POST' })
      await loadData()
    } catch {
      setSkipError(true)
    } finally {
      setSkipping(false)
    }
  }

  if (loading) {
    return <PageLoading label={t('loadingProgress')} />
  }

  if (loadError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <p className="text-fl-muted-2 font-mono text-sm">{tError('body')}</p>
        <button
          onClick={() => {
            setLoadError(false)
            setLoading(true)
            loadData()
          }}
          className="text-fl-accent font-mono text-xs tracking-widest uppercase underline"
        >
          {tError('retry')}
        </button>
      </div>
    )
  }

  const skillEntries = Object.entries(skills)
    .map(([skill, value]) => ({ skill, value: value as number }))
    .sort((a, b) => a.value - b.value)
  const completedLessonCount = todayLessons.filter(
    (lesson) =>
      (lesson.id && completedToday.includes(lesson.id)) || lesson.isCompleted
  ).length
  const nextLesson = todayLessons.find(
    (lesson) =>
      lesson.id && !completedToday.includes(lesson.id) && !lesson.isCompleted
  )
  const planPositionComplete =
    completion?.state === 'ready' || completion?.state === 'taken'
  const planCompletion =
    hasPlan && totalDays > 0
      ? planPositionComplete
        ? 100
        : Math.min(100, Math.round((progressDay / totalDays) * 100))
      : 0
  const daysRemaining = hasPlan
    ? planPositionComplete
      ? 0
      : Math.max(totalDays - progressDay, 0)
    : 0
  const currentDayDisplay = planPositionComplete
    ? totalDays
    : Math.min(progressDay + 1, totalDays)
  const vocabularyProgressPct = Math.round(vocabularyProgress * 100)
  const paymentRecovery = needsPaymentRecovery(user)
  const showPremiumBanner =
    stripeEnabled && !isSubscribed(user, stripeEnabled) && !freemiumTrialActive

  function getPerformanceLabel(value: number) {
    if (value < 0.5) return t('performanceNeedsPractice')
    if (value < 0.8) return t('performanceInProgress')
    return t('performanceStrong')
  }

  return (
    <>
      <OnboardingTour />
      <WhatsNew />
      <div
        className="mx-auto max-w-4xl p-6"
        onClick={(event) => {
          const link =
            event.target instanceof Element
              ? event.target.closest('a[href]')
              : null
          if (link && event.currentTarget.contains(link))
            trackDashboardLink(link.getAttribute('href') ?? '')
        }}
      >
        {/* Header */}
        <div className="glass-card animate-fade-up mb-6 rounded-2xl p-5 sm:p-6">
          <p className="text-fl-label text-fl-muted-2 mb-1 font-mono tracking-widest uppercase">
            {t('welcomeBack')}
          </p>
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
            <div>
              <h1 className="text-fl-fg font-mono text-2xl font-bold tracking-tight">
                {user?.displayName || user?.username}
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-xs sm:text-sm">
                <span className="glass-card inline-flex items-center gap-2 rounded-full px-3 py-1 text-fl-muted-2">
                  <span className="text-fl-hint tracking-wider uppercase text-fl-muted-3">
                    {tLang('baseLanguageLabel')}:
                  </span>
                  <span className="text-fl-fg font-semibold">
                    {tLang(user?.native_language || 'en')}
                  </span>
                  <span className="rounded-full border border-blue-500/25 bg-blue-500/12 px-2 py-0.5 text-[10px] font-semibold text-blue-500 uppercase">
                    {tLang('fluentBadge')}
                  </span>
                </span>
                <span className="text-blue-500/70">➔</span>
                {activeLanguage && (
                  <span className="glass-card inline-flex items-center gap-2 rounded-full px-3 py-1 text-fl-muted-2">
                    <span className="text-fl-hint tracking-wider uppercase text-fl-muted-3">
                      {tLang('targetLanguageLabel')}:
                    </span>
                    <span className="text-fl-fg font-semibold">
                      {tTarget(activeLanguage.code)}
                      {cefrLevel ? ` (${cefrLevel})` : ''}
                    </span>
                    <span className="rounded-full border border-sky-500/25 bg-sky-500/12 px-2 py-0.5 text-[10px] font-semibold text-sky-500 uppercase">
                      {tLang('learningBadge')}
                    </span>
                  </span>
                )}
              </div>
            </div>
            {hasPlan && totalDays > 0 && (
              <p className="text-fl-hint text-fl-muted-2 font-mono tracking-widest uppercase">
                {t('dayProgress', {
                  current: currentDayDisplay,
                  total: totalDays,
                })}
              </p>
            )}
          </div>
        </div>

        <DashboardAnnouncement />

        {/* Next step */}
        <div
          className="neu-card animate-fade-up mb-8 rounded-2xl p-6"
          style={{ animationDelay: '70ms' }}
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-fl-label text-fl-muted-2 font-mono tracking-widest uppercase">
              {t('nextStep')}
            </p>
            {hasPlan && todayLessons.length > 0 && (
              <div className="text-fl-caption font-mono">
                <p className="text-fl-muted-1">{t('planDayGoal')}</p>
                <p className="text-fl-fg mt-1">
                  {t('completedToday', {
                    completed: completedLessonCount,
                    total: todayLessons.length,
                  })}
                </p>
              </div>
            )}
          </div>
          {!hasPlan ? (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-fl-fg font-mono text-xl font-bold tracking-tight">
                  {t('startWithAssessment')}
                </h2>
                <p className="text-fl-muted-2 mt-2 max-w-xl font-mono text-sm">
                  {t('assessmentCreatesPlan')}
                </p>
              </div>
              <Link href="/assessment">
                <button className="neu-button-primary rounded-xl px-5 py-2.5 font-mono text-sm font-bold tracking-widest uppercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500">
                  {t('takeAssessmentArrow')}
                </button>
              </Link>
            </div>
          ) : completion?.state === 'taken' ? (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-fl-fg font-mono text-xl font-bold tracking-tight">
                  {t('levelTestCompleted')}
                </h2>
                <p className="text-fl-muted-2 mt-2 font-mono text-sm">
                  {t('levelTestScoreLine', {
                    score:
                      completion.score != null
                        ? `${Math.round(completion.score * 100)}%`
                        : '—',
                  })}
                </p>
              </div>
              {completion.next_level != null ? (
                <Link href="/assessment">
                  <button className="neu-button-primary rounded-xl px-5 py-2.5 font-mono text-sm font-bold tracking-widest uppercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500">
                    {tAssessment('retake')}
                  </button>
                </Link>
              ) : (
                <Link href="/plan">
                  <button className="neu-button-primary rounded-xl px-5 py-2.5 font-mono text-sm font-bold tracking-widest uppercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500">
                    {t('goToMyPlan')}
                  </button>
                </Link>
              )}
            </div>
          ) : completion?.state === 'ready' ? (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-fl-fg font-mono text-xl font-bold tracking-tight">
                  {t('levelTestReady')}
                </h2>
                <p className="text-fl-muted-2 mt-2 max-w-xl font-mono text-sm">
                  {t('levelTestReadyDesc')}
                </p>
              </div>
              {planId != null && (
                <Link href={`/assessment/level-test?plan=${planId}`}>
                  <button className="neu-button-primary rounded-xl px-5 py-2.5 font-mono text-sm font-bold tracking-widest uppercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500">
                    {tPlan('beginLevelTest')}
                  </button>
                </Link>
              )}
            </div>
          ) : nextLesson ? (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-fl-hint text-fl-muted-2 mb-2 font-mono tracking-widest uppercase">
                  {t('lessonReady')}
                </p>
                <h2 className="text-fl-fg font-mono text-xl font-bold tracking-tight">
                  {localizeLessonTitle(
                    {
                      title: nextLesson.title,
                      unitId: nextLesson.unitId,
                      lessonType: nextLesson.lessonType,
                      cefrLevel,
                      targetLanguage: activeLanguage?.code,
                    },
                    tCommon
                  )}
                </h2>
                <p className="text-fl-muted-2 mt-2 font-mono text-sm">
                  {tPlan(`lessonTypes.${nextLesson.lessonType}`)} ·{' '}
                  {tCommon('minutesShort', {
                    minutes: nextLesson.estimatedMinutes,
                  })}
                </p>
              </div>
              <Link href={`/lesson/${nextLesson.id}`}>
                <button className="neu-button-primary rounded-xl px-5 py-2.5 font-mono text-sm font-bold tracking-widest uppercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500">
                  {t('startLesson')}
                </button>
              </Link>
            </div>
          ) : (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-fl-fg font-mono text-xl font-bold tracking-tight">
                  {t('allCaughtUp')}
                </h2>
                <p className="text-fl-muted-2 mt-2 font-mono text-sm">
                  {pendingCount > 0
                    ? t('pendingStillAvailable', { count: pendingCount })
                    : t('noPendingToday')}
                </p>
              </div>
              <Link href="/plan">
                <button className="neu-button-primary rounded-xl px-5 py-2.5 font-mono text-sm font-bold tracking-widest uppercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500">
                  {t('goToMyPlan')}
                </button>
              </Link>
            </div>
          )}
        </div>

        <ProgressOverview
          xp={xp}
          todayXp={todayXp}
          streak={streak}
          activity={activityWeek}
          lessons={totalLessons}
          correct={exercisesCorrect}
          total={totalExercises}
        />

        <div className="mb-8 grid gap-5 sm:grid-cols-2">
          {/* Plan progress */}
          <div
            className="glass-card animate-fade-up rounded-2xl p-6"
            style={{ animationDelay: '140ms' }}
          >
            <div className="mb-4 flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <span className="text-fl-label text-blue-500">●</span>
                <span className="text-fl-label text-fl-muted-2 font-mono tracking-widest uppercase">
                  {t('planProgress')}
                </span>
              </div>
              {hasPlan && totalDays > 0 && (
                <span className="text-fl-caption text-fl-muted-1 shrink-0 font-mono tracking-widest">
                  {planCompletion}%
                </span>
              )}
            </div>
            {hasPlan && totalDays > 0 ? (
              <>
                <div
                  className="bg-fl-border/60 mb-5 h-3 w-full overflow-hidden rounded-full"
                  role="progressbar"
                  aria-label={t('planProgress')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={planCompletion}
                >
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-sky-400 to-blue-600 transition-[width] duration-500 motion-reduce:transition-none"
                    style={{ width: `${planCompletion}%` }}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="neu-card rounded-xl p-3">
                    <p className="text-fl-hint text-fl-muted-2 mb-1 font-mono tracking-widest uppercase">
                      {t('currentDay')}
                    </p>
                    <p className="text-fl-fg font-mono text-lg font-bold">
                      {currentDayDisplay} / {totalDays}
                    </p>
                  </div>
                  <div className="neu-card rounded-xl p-3">
                    <p className="text-fl-hint text-fl-muted-2 mb-1 font-mono tracking-widest uppercase">
                      {t('daysRemaining')}
                    </p>
                    <p className="text-fl-fg font-mono text-lg font-bold">
                      {daysRemaining}
                    </p>
                  </div>
                </div>
                {vocabularyTotal > 0 && (
                  <div className="mt-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-fl-hint text-fl-muted-2 font-mono tracking-widest uppercase">
                        {t('vocabularyProgress', {
                          level: vocabularyLevel ?? cefrLevel ?? '',
                        })}
                      </p>
                      <p className="text-fl-label text-fl-muted-2 font-mono">
                        {vocabularyProgressPct}%
                      </p>
                    </div>
                    <p className="text-fl-caption text-fl-muted-1 mt-2 font-mono">
                      {t('vocabularyWords', {
                        mastered: vocabularyMastered,
                        total: vocabularyTotal,
                      })}
                    </p>
                    <div
                      className="bg-fl-border/60 mt-3 h-2 w-full overflow-hidden rounded-full"
                      role="progressbar"
                      aria-label={t('vocabularyProgress', {
                        level: vocabularyLevel ?? cefrLevel ?? '',
                      })}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={vocabularyProgressPct}
                    >
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-sky-400 to-blue-600 transition-[width] duration-500 motion-reduce:transition-none"
                        style={{ width: `${vocabularyProgressPct}%` }}
                      />
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-fl-muted-2 font-mono text-xs">
                {t('startWithAssessment')}
              </p>
            )}
          </div>

          {/* Today's lessons */}
          <div
            className="glass-card animate-fade-up rounded-2xl p-6"
            style={{ animationDelay: '200ms' }}
          >
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-fl-label text-sky-500">●</span>
                <span className="text-fl-label text-fl-muted-2 font-mono tracking-widest uppercase">
                  {t('today')}
                </span>
              </div>
            </div>

            {todayLessons.length > 0 ? (
              <div className="space-y-3">
                <div className="mb-4">
                  <p className="text-fl-muted-1 mb-2 text-sm">
                    {t('completedToday', {
                      completed: completedLessonCount,
                      total: todayLessons.length,
                    })}
                  </p>
                  <div className="flex gap-1.5" aria-hidden="true">
                    {todayLessons.map((lesson, index) => (
                      <div
                        key={index}
                        className={`h-2 flex-1 rounded-full transition-colors motion-reduce:transition-none ${(lesson.id && completedToday.includes(lesson.id)) || lesson.isCompleted ? 'bg-gradient-to-r from-sky-400 to-blue-600' : 'bg-fl-border/60'}`}
                      />
                    ))}
                  </div>
                </div>
                {todayLessons.map((lesson, i) => {
                  const isDone =
                    (lesson.id && completedToday.includes(lesson.id)) ||
                    lesson.isCompleted
                  const isNext = nextLesson?.id === lesson.id

                  return (
                    <div
                      key={i}
                      className={`rounded-xl border px-4 py-3 transition-all ${isNext
                        ? 'border-blue-500/45 bg-blue-500/8 shadow-[0_6px_18px_rgba(37,99,235,0.12)]'
                        : 'border-fl-border/70 bg-fl-bg/40'
                        }`}
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <p className="text-fl-fg font-mono text-xs">
                            {localizeLessonTitle(
                              {
                                title: lesson.title,
                                unitId: lesson.unitId,
                                lessonType: lesson.lessonType,
                                cefrLevel,
                                targetLanguage: activeLanguage?.code,
                              },
                              tCommon
                            )}
                          </p>
                          <p className="text-fl-label text-fl-muted-2 mt-0.5 font-mono tracking-wider uppercase">
                            {tPlan(`lessonTypes.${lesson.lessonType}`)} ·{' '}
                            {tCommon('minutesShort', {
                              minutes: lesson.estimatedMinutes,
                            })}
                          </p>
                        </div>
                        {isDone ? (
                          <span className="text-fl-label text-fl-muted-2 inline-flex items-center gap-1.5 font-mono tracking-widest uppercase">
                            <Check
                              className="size-4 shrink-0 text-blue-500"
                              aria-hidden="true"
                            />
                            {t('lessonDone')}
                          </span>
                        ) : lesson.id ? (
                          <Link href={`/lesson/${lesson.id}`}>
                            <button
                              className={`text-fl-caption rounded-lg px-3.5 py-1.5 font-mono tracking-widest uppercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ${isNext
                                ? 'neu-button-primary font-bold'
                                : 'neu-button text-fl-fg'
                                }`}
                            >
                              {t('startLesson')}
                            </button>
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
                <div className="pt-1">
                  <button
                    onClick={skipDay}
                    disabled={skipping}
                    className="text-fl-hint text-fl-muted-3 hover:text-fl-muted-1 font-mono tracking-widest uppercase transition-colors disabled:opacity-40"
                  >
                    {skipping ? '...' : t('skipDay')}
                  </button>
                  {skipError && (
                    <p className="text-fl-error mt-1 font-mono text-xs">
                      {tError('title')}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-fl-muted-2 font-mono text-xs">
                  {hasPlan
                    ? completion?.state === 'ready'
                      ? t('levelTestReady')
                      : completion?.state === 'taken'
                        ? t('levelTestCompleted')
                        : t('allCaughtUp')
                    : t('startWithAssessment')}
                </p>
                {!hasPlan && (
                  <Link href="/assessment">
                    <button className="neu-button-primary rounded-xl px-5 py-2.5 font-mono text-sm font-bold tracking-widest uppercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500">
                      {t('takeAssessmentArrow')}
                    </button>
                  </Link>
                )}
              </div>
            )}
          </div>

          {/* Recent performance */}
          <div
            className="glass-card animate-fade-up rounded-2xl p-6 sm:col-span-2"
            style={{ animationDelay: '260ms' }}
          >
            <div className="mb-4">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-fl-label text-blue-500">●</span>
                <span className="text-fl-label text-fl-muted-2 font-mono tracking-widest uppercase">
                  {t('recentPerformance')}
                </span>
              </div>
              <p className="text-fl-muted-3 font-mono text-xs">
                {t('recentPerformanceDescription')}
              </p>
            </div>
            {skillEntries.length > 0 ? (
              <div className="space-y-3">
                {skillEntries.map(({ skill, value }) => (
                  <div key={skill}>
                    <div className="mb-1 flex justify-between">
                      <span className="text-fl-label text-fl-muted-1 font-mono tracking-widest uppercase">
                        {tPlan(`lessonTypes.${skill}`)}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-fl-label text-fl-muted-3 font-mono tracking-widest uppercase">
                          {getPerformanceLabel(value)}
                        </span>
                        <span className="text-fl-label text-fl-muted-2 font-mono">
                          {Math.round(value * 100)}%
                        </span>
                      </div>
                    </div>
                    <div className="bg-fl-border/60 h-2 w-full overflow-hidden rounded-full">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-sky-400 to-blue-600 transition-[width] duration-500 motion-reduce:transition-none"
                        style={{ width: `${value * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-fl-muted-2 font-mono text-xs">
                {t('noSkills')}
              </p>
            )}
          </div>
        </div>

        {showPremiumBanner && (
          <div className="glass-card animate-fade-up mb-6 rounded-2xl p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex gap-3">
                <span className="text-fl-accent font-mono text-sm leading-none">
                  ★
                </span>
                <div>
                  <p className="text-fl-label text-fl-muted-2 mb-2 font-mono tracking-widest uppercase">
                    {t(
                      paymentRecovery
                        ? 'premiumBannerPastDueTitle'
                        : 'premiumBannerTitle'
                    )}
                  </p>
                  <p className="text-fl-muted-2 font-mono text-xs leading-relaxed">
                    {t(
                      paymentRecovery
                        ? 'premiumBannerPastDueDesc'
                        : 'premiumBannerDescTrialUsed'
                    )}
                  </p>
                </div>
              </div>
              <span className="text-fl-label text-fl-accent border-fl-accent/30 rounded-full border px-3 py-1.5 font-mono tracking-widest whitespace-nowrap uppercase">
                {t(
                  paymentRecovery
                    ? 'premiumBannerPastDueCta'
                    : 'premiumBannerCtaTrialUsed'
                )}
              </span>
            </div>
            {paymentRecovery ? (
              <div className="border-fl-border mt-4 border-t pt-4">
                <button
                  onClick={openPortal}
                  disabled={portalLoading}
                  className="neu-button-primary w-full rounded-xl px-5 py-2.5 font-mono text-sm font-bold tracking-widest uppercase disabled:opacity-50 sm:w-auto"
                >
                  {portalLoading ? '...' : tBilling('updatePayment')}
                </button>
                {portalError && (
                  <p className="text-fl-hint mt-3 font-mono text-red-500">
                    {portalError}
                  </p>
                )}
              </div>
            ) : (
              <SubscriptionPlanButtons className="border-fl-border mt-4 border-t pt-4" />
            )}
          </div>
        )}

        {/* Quick actions */}
        <div className="flex flex-wrap gap-3">
          {hasPlan && (
            <Link href="/plan">
              <button className="neu-button-primary rounded-xl px-5 py-2.5 font-mono text-sm font-bold tracking-widest uppercase">
                {t('goToMyPlan')}
              </button>
            </Link>
          )}
          {pendingCount > 0 && (
            <Link href="/plan">
              <button className="neu-button text-fl-fg rounded-xl px-4 py-2.5 font-mono text-xs tracking-widest uppercase">
                {pendingCount} {t('pendingLessons')} →
              </button>
            </Link>
          )}
          <Link href="/flashcards">
            <button className="neu-button text-fl-fg rounded-xl px-4 py-2.5 font-mono text-xs tracking-widest uppercase">
              {tNav('flashcards')}
            </button>
          </Link>
          <Link href="/chat">
            <button className="neu-button text-fl-fg rounded-xl px-4 py-2.5 font-mono text-xs tracking-widest uppercase">
              {tNav('tutor')}
            </button>
          </Link>
          <Link href="/assessment">
            <button className="neu-button text-fl-fg rounded-xl px-4 py-2.5 font-mono text-xs tracking-widest uppercase">
              {tNav('assessment')}
            </button>
          </Link>
        </div>
      </div>
    </>
  )
}
