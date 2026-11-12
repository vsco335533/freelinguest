'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Check, Diff, X } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useProgressStore } from '@/store/progress'
import { useLanguageStore } from '@/store/language'
import { useAuthStore, isSubscribed, isFreemiumTrialActive } from '@/store/auth'
import { getGrammarTopics, type GrammarTopic } from '@/data/grammar'
import { AudioPlayer } from '@/components/ui/AudioPlayer'
import { VoiceRecorder } from '@/components/ui/VoiceRecorder'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { LessonVoicePracticeButton } from '@/components/lesson/LessonVoicePracticeButton'
import { WordTooltip, useWordSave } from '@/components/ui/WordTooltip'
import { PageLoading } from '@/components/ui/page-loading'
import { FreemiumQuotaBanner } from '@/components/billing/FreemiumQuotaBanner'
import { PaywallBanner } from '@/components/billing/PaywallBanner'
import { useFreemiumStore } from '@/store/freemium'
import { useConfigStore } from '@/store/config'
import { TargetLanguageText } from '@/components/TargetLanguageText'
import {
  ReviewPrompt,
  getReviewPromptDismissal,
} from '@/components/reviews/ReviewPrompt'
import {
  isPlanPositionComplete,
  shouldShowUnitReviewPrompt,
} from '@/lib/review-prompt-triggers'
import { cn } from '@/lib/utils'
import {
  annotateAnswer,
  type FreeWriteCorrection,
} from '@/lib/free-write-corrections'
import {
  formatLanguageName,
  getTargetLanguageTextClass,
} from '@/lib/target-languages'
import { localizeLessonTitle } from '@/lib/curriculum-i18n'

interface ExerciseItem {
  id: number
  exercise_type: string
  question: string
  options: string[] | null
  correct_answer: string
  explanation: string | null
  native_explanation: string | null
  user_answer: string | null
  score: number | null
  feedback: string | null
  corrections: FreeWriteCorrection[] | null
  native_hint: string | null
}

interface LessonData {
  id: number
  study_plan_id: number
  title: string
  lesson_type: string
  cefr_level: string
  unit_id?: string | null
  content: Record<string, unknown>
  is_completed: boolean
}

interface LessonVocabularyItem {
  word?: string
  definition?: string
  translation?: string | null
  example?: string
  example_translation?: string | null
  note?: string | null
  reading?: string | null
}

function getLessonUnitId(lesson: LessonData | null): string | null {
  const direct = lesson?.unit_id
  if (typeof direct === 'string' && direct) return direct
  const unitId = lesson?.content?.unit_id
  return typeof unitId === 'string' && unitId ? unitId : null
}

export default function LessonPage() {
  const t = useTranslations('lesson')
  const tCommon = useTranslations('common')
  const tPlan = useTranslations('plan')
  const tError = useTranslations('error')
  const tLang = useTranslations('languages')
  const locale = useLocale()
  const params = useParams()
  const router = useRouter()
  const id = params.id as string
  const completeLesson = useProgressStore((s) => s.completeLesson)
  const activeLanguage = useLanguageStore((s) => s.activeLanguage)
  const user = useAuthStore((s) => s.user)
  const stripeEnabled = useConfigStore((s) => s.stripeEnabled)
  const fetchFreemium = useFreemiumStore((s) => s.fetchStatus)
  const freemiumStatus = useFreemiumStore((s) => s.status)
  const freemiumExhausted =
    stripeEnabled &&
    !isSubscribed(user, stripeEnabled) &&
    !isFreemiumTrialActive(user, stripeEnabled) &&
    freemiumStatus &&
    freemiumStatus.lessons_remaining <= 0
  const nativeLanguageName = user?.native_language
    ? formatLanguageName(tLang(user.native_language), locale)
    : ''
  const langAtLoad = useRef(activeLanguage?.code ?? null)
  const {
    selectedWord,
    tooltipPos,
    saveState,
    handleTextSelection,
    handleSaveWord,
    dismissTooltip,
  } = useWordSave()

  const [lesson, setLesson] = useState<LessonData | null>(null)
  const [lessonTargetLanguage, setLessonTargetLanguage] = useState<string>()
  const [exercises, setExercises] = useState<ExerciseItem[]>([])
  const [currentExercise, setCurrentExercise] = useState(0)
  const [answer, setAnswer] = useState('')
  const [evaluating, setEvaluating] = useState(false)
  const [completed, setCompleted] = useState(false)
  const [dayComplete, setDayComplete] = useState(false)
  const [reviewPromptOpen, setReviewPromptOpen] = useState(false)
  const [progressDayAtStart, setProgressDayAtStart] = useState(-1)
  const [grammarTopics, setGrammarTopics] = useState<GrammarTopic[]>([])

  useEffect(() => {
    getGrammarTopics(activeLanguage?.code ?? 'en-GB')
      .then(setGrammarTopics)
      .catch(() => setGrammarTopics([]))
  }, [activeLanguage?.code])

  useEffect(() => {
    if (stripeEnabled && !isSubscribed(user, stripeEnabled)) {
      fetchFreemium()
    }
  }, [stripeEnabled, user, fetchFreemium])

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [submitError, setSubmitError] = useState(false)
  const [regeneratingExercise, setRegeneratingExercise] = useState(false)
  const [regenerateError, setRegenerateError] = useState<string | null>(null)
  const [showExitConfirm, setShowExitConfirm] = useState(false)
  const [loadingNativeExplanation, setLoadingNativeExplanation] =
    useState(false)
  const [nativeExplanationError, setNativeExplanationError] = useState(false)
  const [nativeExplanationOpen, setNativeExplanationOpen] = useState(false)
  const [
    loadingExerciseNativeExplanationId,
    setLoadingExerciseNativeExplanationId,
  ] = useState<number | null>(null)
  const [
    exerciseNativeExplanationErrorId,
    setExerciseNativeExplanationErrorId,
  ] = useState<number | null>(null)
  const [openNativeHintIds, setOpenNativeHintIds] = useState<Set<number>>(
    () => new Set()
  )
  const [loadingExerciseNativeHintId, setLoadingExerciseNativeHintId] =
    useState<number | null>(null)
  const [exerciseNativeHintErrorId, setExerciseNativeHintErrorId] = useState<
    number | null
  >(null)
  const completingLessonRef = useRef(false)
  const [completingLesson, setCompletingLesson] = useState(false)
  const isReview = lesson?.is_completed ?? false

  const loadLesson = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch(`/api/lessons/${id}`)
      const data = await res.json()
      setLesson(data.lesson)
      setLessonTargetLanguage(data.target_language)
      setExercises(data.exercises)
      setNativeExplanationOpen(
        data.lesson?.cefr_level === 'A1' || data.lesson?.cefr_level === 'A2'
      )
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    loadLesson()
  }, [loadLesson])

  const generateNativeExplanation = async () => {
    setLoadingNativeExplanation(true)
    setNativeExplanationError(false)
    try {
      const res = await apiFetch(`/api/lessons/${id}/native-explanation`, {
        method: 'POST',
      })
      if (!res.ok) {
        setNativeExplanationError(true)
        return
      }
      const data = await res.json()
      if (data.native_explanation) {
        setLesson((prev) => {
          if (!prev) return prev
          return {
            ...prev,
            content: {
              ...prev.content,
              native_explanation: data.native_explanation,
            },
          }
        })
      }
    } catch {
      setNativeExplanationError(true)
    } finally {
      setLoadingNativeExplanation(false)
    }
  }

  const generateExerciseNativeExplanation = async (exerciseId: number) => {
    setLoadingExerciseNativeExplanationId(exerciseId)
    setExerciseNativeExplanationErrorId(null)
    try {
      const res = await apiFetch(
        `/api/lessons/exercises/${exerciseId}/native-explanation`,
        { method: 'POST' }
      )
      if (!res.ok) {
        setExerciseNativeExplanationErrorId(exerciseId)
        return
      }
      const data = await res.json()
      if (data.native_explanation) {
        setExercises((prev) =>
          prev.map((item) =>
            item.id === exerciseId
              ? { ...item, native_explanation: data.native_explanation }
              : item
          )
        )
      }
    } catch {
      setExerciseNativeExplanationErrorId(exerciseId)
    } finally {
      setLoadingExerciseNativeExplanationId(null)
    }
  }

  const showExerciseNativeHint = async (exerciseId: number) => {
    const existing = exercises.find((item) => item.id === exerciseId)
    setOpenNativeHintIds((prev) => new Set(prev).add(exerciseId))
    if (existing?.native_hint) return

    setLoadingExerciseNativeHintId(exerciseId)
    setExerciseNativeHintErrorId(null)
    try {
      const res = await apiFetch(
        `/api/lessons/exercises/${exerciseId}/native-hint`,
        { method: 'POST' }
      )
      if (!res.ok) {
        setExerciseNativeHintErrorId(exerciseId)
        return
      }
      const data = await res.json()
      if (data.native_hint) {
        setExercises((prev) =>
          prev.map((item) =>
            item.id === exerciseId
              ? { ...item, native_hint: data.native_hint }
              : item
          )
        )
      }
    } catch {
      setExerciseNativeHintErrorId(exerciseId)
    } finally {
      setLoadingExerciseNativeHintId(null)
    }
  }

  // Capture progress_day at the time the lesson starts (for day-complete detection)
  useEffect(() => {
    apiFetch('/api/study-plan/today')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.progress_day !== undefined) setProgressDayAtStart(d.progress_day)
      })
      .catch(() => { })
  }, [])

  // Redirect to plan page if the user switches language while viewing a lesson
  useEffect(() => {
    const current = activeLanguage?.code ?? null
    if (langAtLoad.current && current && current !== langAtLoad.current) {
      router.replace('/plan')
    }
  }, [activeLanguage?.code, router])

  // Restore the answer field whenever the active exercise changes
  // (seeds previous user_answer for already-answered exercises, clears for fresh ones)
  useEffect(() => {
    const ex = exercises[currentExercise]
    setAnswer(
      ex?.score !== null && ex?.score !== undefined
        ? (ex.user_answer ?? '')
        : ''
    )
    setRegenerateError(null)
  }, [currentExercise, exercises])

  // Navigation or regeneration can replace the selected text. Answers and
  // hints keep the question unchanged and must not close a tooltip mid-save.
  const activeQuestion = exercises[currentExercise]?.question
  useEffect(() => {
    dismissTooltip()
  }, [currentExercise, activeQuestion, dismissTooltip])

  async function submitAnswer(overrideAnswer?: string) {
    if (isReview) return
    const finalAnswer = overrideAnswer ?? answer
    if (!finalAnswer.trim()) return
    const exercise = exercises[currentExercise]
    setEvaluating(true)
    try {
      const res = await apiFetch(
        `/api/lessons/exercises/${exercise.id}/answer`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer: finalAnswer }),
        }
      )
      const result = await res.json()
      setExercises((prev) => {
        const copy = [...prev]
        copy[currentExercise] = {
          ...copy[currentExercise],
          score: result.score,
          feedback: result.feedback,
          corrections: result.corrections ?? null,
          user_answer: finalAnswer,
        }
        return copy
      })
      if (overrideAnswer !== undefined) setAnswer(overrideAnswer)
      setSubmitError(false)
    } catch {
      setSubmitError(true)
    } finally {
      setEvaluating(false)
    }
  }

  async function regenerateCurrentExercise() {
    const exercise = exercises[currentExercise]
    if (!exercise || isEvaluated || isReview) return

    setRegeneratingExercise(true)
    setRegenerateError(null)
    try {
      const res = await apiFetch(
        `/api/lessons/exercises/${exercise.id}/regenerate`,
        { method: 'POST' }
      )
      if (!res.ok) {
        setRegenerateError(
          res.status === 400 ? t('regenerateNotNeeded') : t('regenerateError')
        )
        return
      }
      const regenerated = await res.json()
      setExercises((prev) => {
        const copy = [...prev]
        copy[currentExercise] = regenerated
        return copy
      })
      setAnswer('')
      setSubmitError(false)
    } catch {
      setRegenerateError(t('regenerateError'))
    } finally {
      setRegeneratingExercise(false)
    }
  }

  function nextExercise() {
    if (currentExercise < exercises.length - 1) {
      setCurrentExercise(currentExercise + 1)
    }
  }

  async function completeLessonHandler() {
    if (completingLessonRef.current) return
    completingLessonRef.current = true
    setCompletingLesson(true)

    try {
      const completedUnitId = getLessonUnitId(lesson)
      const res = await apiFetch(`/api/lessons/${id}/complete`, {
        method: 'POST',
      })
      if (!res.ok) return
      if (
        !isSubscribed(user, stripeEnabled) &&
        !isFreemiumTrialActive(user, stripeEnabled)
      ) {
        await fetchFreemium(true)
      }
      if (lesson) completeLesson(lesson.id)
      // Detect if completing this lesson advanced the plan to the next day
      try {
        const todayRes = await apiFetch('/api/study-plan/today')
        if (todayRes.ok) {
          const d = await todayRes.json()
          if (progressDayAtStart >= 0 && d.progress_day > progressDayAtStart) {
            setDayComplete(true)
          }
          const nextUnitId = d.lessons?.find(
            (item: { unit_id?: string | null }) => item.unit_id
          )?.unit_id
          const planComplete = isPlanPositionComplete(d)
          const unitCompleted =
            !!completedUnitId &&
            ((!!nextUnitId && nextUnitId !== completedUnitId) || planComplete)
          if (
            shouldShowUnitReviewPrompt(
              getReviewPromptDismissal(),
              unitCompleted
            )
          ) {
            setReviewPromptOpen(true)
          }
        }
      } catch {
        // Non-fatal: failing to detect day-advance does not prevent lesson completion
      }
      setCompleted(true)
    } finally {
      completingLessonRef.current = false
      setCompletingLesson(false)
    }
  }

  if (loading) {
    return <PageLoading label={t('loading')} />
  }

  if (loadError) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6">
        <p className="text-fl-muted-1 font-mono text-sm font-medium">{tError('body')}</p>
        <button
          onClick={() => {
            setLoadError(false)
            loadLesson()
          }}
          className="neu-button text-fl-accent rounded-xl px-4 py-2 font-mono text-xs font-bold tracking-widest uppercase transition-all"
        >
          {tError('retry')}
        </button>
        <Link
          href="/dashboard"
          className="text-fl-muted-2 hover:text-fl-fg font-mono text-xs font-semibold tracking-widest uppercase underline"
        >
          {t('backToPlan')}
        </Link>
      </div>
    )
  }

  if (completingLesson) {
    return <PageLoading label={t('completing')} />
  }

  if (completed) {
    return (
      <>
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 p-6">
          <div className="neu-glass-card w-full max-w-xl rounded-3xl px-6 py-10 text-center sm:px-10">
            <p className="text-fl-label text-fl-muted-2 mb-4 flex items-center justify-center gap-2 font-mono font-semibold tracking-widest uppercase">
              <Check className="text-fl-accent size-4 shrink-0" aria-hidden="true" />
              {tCommon('complete')}
            </p>
            <p className="text-fl-fg font-mono text-xl font-bold tracking-widest">
              {t('lessonDone')}
            </p>
            <p className="text-fl-muted-1 mt-3 font-mono text-sm font-medium">
              {localizedLessonTitle}
            </p>
            {exercises.length > 0 && (
              <p className="text-fl-caption text-fl-muted-1 mt-4 font-mono font-semibold">
                {t('exerciseSummary', {
                  completed: exercises.filter((item) => item.score != null)
                    .length,
                  total: exercises.length,
                })}
              </p>
            )}
            {dayComplete && (
              <div className="glass-card border-fl-accent/35 bg-fl-accent/10 mt-6 rounded-2xl px-6 py-4">
                <p className="text-fl-accent font-mono text-sm font-bold tracking-widest">
                  {t('dayComplete')}
                </p>
                <p className="text-fl-muted-1 mt-1 font-mono text-xs font-medium">
                  {t('dayCompleteMsg')}
                </p>
              </div>
            )}
            <div className="mt-8 flex flex-col items-center gap-4">
              {lesson && (
                <LessonVoicePracticeButton
                  lessonId={lesson.id}
                  title={localizedLessonTitle}
                  targetLanguage={lessonTargetLanguage}
                />
              )}
              <Link
                href="/plan"
                className="neu-button-primary rounded-xl px-8 py-3 font-mono text-sm font-bold tracking-widest uppercase transition-all"
              >
                {t('backToPlan')}
              </Link>
              <Link
                href="/dashboard"
                className="text-fl-muted-2 hover:text-fl-fg font-mono text-xs font-semibold underline underline-offset-4 transition-colors"
              >
                {tCommon('backToDashboard')}
              </Link>
            </div>
          </div>
        </div>
        <ReviewPrompt
          open={reviewPromptOpen}
          onClose={() => setReviewPromptOpen(false)}
          onSubmitted={() => setReviewPromptOpen(false)}
        />
      </>
    )
  }

  const exercise = exercises[currentExercise]
  const targetLanguageCode =
    lessonTargetLanguage ?? activeLanguage?.code ?? 'en-GB'
  const localizedLessonTitle = lesson
    ? localizeLessonTitle(
      {
        title: lesson.title,
        unitId: getLessonUnitId(lesson),
        lessonType: lesson.lesson_type,
        cefrLevel: lesson.cefr_level,
        targetLanguage: targetLanguageCode,
      },
      tCommon
    )
    : ''
  const isEvaluated = exercise?.score !== null
  const isAnswerCorrect = (exercise?.score ?? 0) >= 1
  const exerciseCorrections = (exercise?.corrections ?? []).filter(
    (c) => c.original && c.corrected
  )
  // Amber only when the evaluator returned corrections with a partial score.
  // The LLM-unavailable fallback (score 0.5, no corrections) stays red/✕.
  const isPartiallyCorrect =
    exercise?.exercise_type === 'free_write' &&
    isEvaluated &&
    !isAnswerCorrect &&
    (exercise?.score ?? 0) > 0 &&
    exerciseCorrections.length > 0
  const answerSegments =
    exercise?.exercise_type === 'free_write' &&
      isEvaluated &&
      exercise?.user_answer &&
      exerciseCorrections.length > 0
      ? annotateAnswer(exercise.user_answer, exerciseCorrections)
      : null
  const showAnnotatedAnswer = !!answerSegments?.some((s) => s.type === 'fix')
  const isNativeHintOpen = exercise ? openNativeHintIds.has(exercise.id) : false
  const hasMultipleChoiceOptions =
    exercise?.exercise_type === 'multiple_choice' &&
    Array.isArray(exercise.options) &&
    exercise.options.length > 0
  const explanation = lesson?.content?.explanation as
    Record<string, unknown> | undefined
  const nativeExplanation = lesson?.content?.native_explanation as
    Record<string, unknown> | undefined

  return (
    <>
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        {!isReview && <FreemiumQuotaBanner feature="lessons" />}
        {isReview && lesson && (
          <LessonVoicePracticeButton
            lessonId={lesson.id}
            title={localizedLessonTitle}
            targetLanguage={lessonTargetLanguage}
          />
        )}
        {/* Lesson header */}
        <div className="glass-card overflow-hidden rounded-2xl">
          <div className="border-fl-border/60 flex items-center justify-between border-b px-6 py-4">
            <div className="flex items-center gap-2">
              <span className="text-fl-label text-fl-accent">●</span>
              <span className="text-fl-label text-fl-muted-2 font-mono font-semibold tracking-widest uppercase">
                {t('label')}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-fl-hint text-fl-muted-1 border-fl-border rounded-full border bg-white/60 px-2.5 py-1 font-mono font-semibold tracking-widest uppercase">
                {lesson?.cefr_level}
              </span>
              <span className="text-fl-hint text-fl-muted-1 border-fl-border rounded-full border bg-white/60 px-2.5 py-1 font-mono font-semibold tracking-widest uppercase">
                {lesson?.lesson_type
                  ? ((
                    {
                      grammar: tPlan('lessonTypes.grammar'),
                      vocabulary: tPlan('lessonTypes.vocabulary'),
                      reading: tPlan('lessonTypes.reading'),
                      writing: tPlan('lessonTypes.writing'),
                      listening: tPlan('lessonTypes.listening'),
                      review: tPlan('lessonTypes.review'),
                      level_test: tPlan('lessonTypes.level_test'),
                    } as Record<string, string>
                  )[lesson.lesson_type] ?? lesson.lesson_type)
                  : ''}
              </span>
              <button
                onClick={() =>
                  isReview ? router.push('/plan') : setShowExitConfirm(true)
                }
                className="neu-button text-fl-muted-1 hover:text-fl-fg ml-1 inline-flex size-8 items-center justify-center rounded-full font-mono text-sm leading-none transition-all"
                aria-label={t('exit')}
              >
                ✕
              </button>
            </div>
          </div>
          <div className="px-6 py-5">
            <p className="text-fl-fg font-mono text-base font-bold tracking-wide">
              {localizedLessonTitle}
            </p>
            {explanation && (
              <div className="mt-4 max-w-[70ch] space-y-3">
                {explanation.text != null && (
                  <TargetLanguageText
                    as="p"
                    languageCode={targetLanguageCode}
                    className="text-fl-muted-1 word-selectable cursor-text select-text"
                    onPointerUp={() =>
                      handleTextSelection(
                        String(explanation.text),
                        lesson?.cefr_level ?? 'B1'
                      )
                    }
                  >
                    {String(explanation.text)}
                  </TargetLanguageText>
                )}
                {(explanation.key_points as string[])?.length > 0 && (
                  <ul className="border-fl-border/60 space-y-1 border-t pt-3">
                    {(explanation.key_points as string[]).map((kp, i) => (
                      <li key={i} className="text-fl-muted-1">
                        <span className="text-fl-muted-2 mr-2">·</span>
                        <TargetLanguageText languageCode={targetLanguageCode}>
                          {kp}
                        </TargetLanguageText>
                      </li>
                    ))}
                  </ul>
                )}
                {(explanation.examples as { sentence: string; note: string }[])
                  ?.length > 0 && (
                    <div className="border-fl-border/60 space-y-2 border-t pt-3">
                      <p className="text-fl-label text-fl-muted-2 font-mono font-semibold tracking-widest uppercase">
                        {t('examples')}
                      </p>
                      {(
                        explanation.examples as {
                          sentence: string
                          note: string
                        }[]
                      ).map((ex, i) => (
                        <div key={i} className="flex items-start gap-3">
                          <span className="text-fl-muted-3 mt-0.5">·</span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <TargetLanguageText
                                languageCode={targetLanguageCode}
                                className="text-fl-muted-1 italic"
                              >
                                {ex.sentence}
                              </TargetLanguageText>
                              <AudioPlayer
                                text={ex.sentence}
                                studyPlanId={lesson?.study_plan_id}
                                size="sm"
                              />
                            </div>
                            {ex.note && (
                              <p className="text-fl-muted-1 mt-0.5 font-sans text-sm leading-relaxed">
                                {ex.note}
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
              </div>
            )}
            {/* Native explanation */}
            {nativeLanguageName && (
              <div className="border-fl-border/60 mt-4 border-t pt-4">
                <button
                  type="button"
                  onClick={() => setNativeExplanationOpen((open) => !open)}
                  className="text-fl-label text-fl-muted-2 hover:text-fl-fg flex w-full items-center justify-between font-mono font-semibold tracking-widest uppercase transition-colors"
                  aria-expanded={nativeExplanationOpen}
                >
                  <span>{nativeLanguageName}</span>
                  <span>{nativeExplanationOpen ? '−' : '+'}</span>
                </button>
                {nativeExplanationOpen &&
                  (nativeExplanation ? (
                    <div className="mt-3 max-w-[70ch] space-y-3">
                      {String(nativeExplanation.text ?? '') && (
                        <p className="text-fl-muted-1 text-base leading-relaxed">
                          {String(nativeExplanation.text)}
                        </p>
                      )}
                      {(nativeExplanation.key_points as string[])?.length >
                        0 && (
                          <ul className="space-y-1">
                            {(nativeExplanation.key_points as string[]).map(
                              (kp, i) => (
                                <li
                                  key={i}
                                  className="text-fl-muted-1 text-base leading-relaxed"
                                >
                                  <span className="text-fl-muted-2 mr-2">·</span>
                                  {kp}
                                </li>
                              )
                            )}
                          </ul>
                        )}
                      {(
                        nativeExplanation.examples as {
                          sentence: string
                          note: string
                        }[]
                      )?.length > 0 && (
                          <div className="space-y-2">
                            <p className="text-fl-label text-fl-muted-3 font-mono text-xs tracking-widest uppercase">
                              {t('examples')}
                            </p>
                            {(
                              nativeExplanation.examples as {
                                sentence: string
                                note: string
                              }[]
                            ).map((ex, i) => (
                              <div key={i} className="flex items-start gap-3">
                                <span className="text-fl-muted-3 mt-0.5 text-sm">
                                  ·
                                </span>
                                <div className="min-w-0 flex-1">
                                  <TargetLanguageText
                                    languageCode={targetLanguageCode}
                                    className="text-fl-muted-1 text-sm italic"
                                  >
                                    {ex.sentence}
                                  </TargetLanguageText>
                                  {ex.note && (
                                    <p className="text-fl-muted-1 mt-0.5 text-sm leading-relaxed">
                                      {ex.note}
                                    </p>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      {(
                        nativeExplanation.common_traps as {
                          mistake: string
                          fix: string
                        }[]
                      )?.length > 0 && (
                          <div className="border-fl-border/60 space-y-2 border-t pt-3">
                            <p className="text-fl-label text-fl-muted-2 font-mono text-xs font-semibold tracking-widest uppercase">
                              {t('commonTraps')}
                            </p>
                            {(
                              nativeExplanation.common_traps as {
                                mistake: string
                                fix: string
                              }[]
                            ).map((trap, i) => (
                              <div key={i} className="space-y-0.5">
                                <p className="text-fl-muted-2 text-sm font-medium">
                                  {trap.mistake}
                                </p>
                                <p className="text-fl-muted-1 text-sm leading-relaxed">
                                  {trap.fix}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}
                      {(
                        nativeExplanation.mini_glossary as {
                          term: string
                          meaning: string
                          note?: string
                        }[]
                      )?.length > 0 && (
                          <div className="border-fl-border/60 space-y-2 border-t pt-3">
                            <p className="text-fl-label text-fl-muted-2 font-mono text-xs font-semibold tracking-widest uppercase">
                              {t('miniGlossary')}
                            </p>
                            {(
                              nativeExplanation.mini_glossary as {
                                term: string
                                meaning: string
                                note?: string
                              }[]
                            ).map((item, i) => (
                              <div key={i}>
                                <TargetLanguageText
                                  languageCode={targetLanguageCode}
                                  className="text-fl-muted-1 text-sm font-bold"
                                >
                                  {item.term}
                                </TargetLanguageText>
                                <p className="text-fl-muted-2 text-sm font-medium">
                                  {item.meaning}
                                </p>
                                {item.note && (
                                  <p className="text-fl-muted-1 text-sm leading-relaxed">
                                    {item.note}
                                  </p>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                    </div>
                  ) : (
                    <div className="mt-3 text-center">
                      <button
                        onClick={generateNativeExplanation}
                        disabled={loadingNativeExplanation}
                        className="neu-button text-fl-hint text-fl-muted-1 hover:text-fl-fg rounded-xl px-4 py-2 font-mono text-xs font-semibold transition-all"
                      >
                        {loadingNativeExplanation
                          ? '...'
                          : nativeExplanationError
                            ? tCommon('retry')
                            : `${t('showNativeExplanation')} ${nativeLanguageName}`}
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>

        {/* Exercise */}
        {exercise && (
          <div className="glass-card overflow-hidden rounded-2xl">
            <div className="border-fl-border/60 flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
              <div className="flex items-center gap-2">
                <span className="text-fl-label text-fl-accent">●</span>
                <span className="text-fl-caption text-fl-muted-1 font-mono font-semibold tracking-widest uppercase">
                  {t('exercise')} {currentExercise + 1} / {exercises.length}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-fl-hint text-fl-muted-1 border-fl-border rounded-full border bg-white/60 px-2.5 py-1 font-mono font-semibold tracking-widest uppercase">
                  {(
                    {
                      multiple_choice: t('exerciseTypeMultipleChoice'),
                      fill_blank: t('exerciseTypeFillBlank'),
                      free_write: t('exerciseTypeFreeWrite'),
                      pronunciation: t('exerciseTypePronunciation'),
                    } as Record<string, string>
                  )[exercise.exercise_type] ?? exercise.exercise_type}
                </span>
                {!isEvaluated && !isReview && (
                  <button
                    type="button"
                    onClick={regenerateCurrentExercise}
                    disabled={regeneratingExercise}
                    className="neu-button text-fl-caption text-fl-muted-1 hover:text-fl-fg rounded-xl px-3 py-1 font-mono font-semibold tracking-widest uppercase transition-all disabled:opacity-50"
                  >
                    {regeneratingExercise
                      ? t('regeneratingExercise')
                      : t('regenerateExercise')}
                  </button>
                )}
              </div>
            </div>

            {/* Progress bar */}
            <div className="bg-fl-border/60 h-1.5 overflow-hidden">
              <div
                className="bg-fl-accent h-full rounded-r-full transition-[width] duration-300 motion-reduce:transition-none"
                style={{
                  width: `${Math.round(((currentExercise + 1) / exercises.length) * 100)}%`,
                }}
              />
            </div>

            <div className="space-y-5 px-6 py-6">
              <TargetLanguageText
                as="p"
                languageCode={targetLanguageCode}
                className="text-fl-fg word-selectable cursor-text select-text"
                onPointerUp={() =>
                  handleTextSelection(
                    exercise.question,
                    lesson?.cefr_level ?? 'B1'
                  )
                }
              >
                {exercise.question}
              </TargetLanguageText>
              {regenerateError && (
                <p className="text-fl-error font-mono text-xs">
                  {regenerateError}
                </p>
              )}

              {nativeLanguageName &&
                (!isEvaluated ||
                  (isNativeHintOpen && exercise.native_hint)) && (
                  <div className="neu-card rounded-2xl px-4 py-3">
                    {isNativeHintOpen && exercise.native_hint ? (
                      <div className="space-y-2">
                        <p className="text-fl-label text-fl-muted-2 font-mono font-semibold tracking-widest">
                          {t('hint')}
                        </p>
                        <p className="text-fl-muted-1 max-w-[70ch] text-sm leading-relaxed">
                          {exercise.native_hint}
                        </p>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => showExerciseNativeHint(exercise.id)}
                        disabled={loadingExerciseNativeHintId === exercise.id}
                        className="text-fl-hint text-fl-muted-1 hover:text-fl-fg font-mono text-sm font-semibold transition-colors disabled:opacity-50"
                      >
                        {loadingExerciseNativeHintId === exercise.id
                          ? '...'
                          : exerciseNativeHintErrorId === exercise.id
                            ? tCommon('retry')
                            : `${t('showNativeHint')} ${nativeLanguageName}`}
                      </button>
                    )}
                  </div>
                )}

              {hasMultipleChoiceOptions ? (
                <div className="space-y-2">
                  {exercise.options!.map((opt) => {
                    const isSelected = answer === opt
                    const isCorrect =
                      isEvaluated && opt === exercise.correct_answer
                    const isWrongSelection =
                      isEvaluated && isSelected && !isCorrect
                    return (
                      <button
                        key={opt}
                        disabled={isEvaluated || isReview}
                        onClick={() => setAnswer(opt)}
                        className={`neu-card flex w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3.5 text-left font-medium transition-all disabled:opacity-100 ${isCorrect
                            ? 'text-fl-fg border-fl-success/50 bg-fl-success/10'
                            : isWrongSelection
                              ? 'text-fl-fg border-fl-error-fg/50 bg-fl-error-fg/10'
                              : isSelected
                                ? 'border-fl-accent bg-fl-accent text-fl-accent-fg shadow-md'
                                : 'border-fl-border/70 text-fl-fg hover:border-fl-accent/50'
                          }`}
                      >
                        <TargetLanguageText
                          languageCode={targetLanguageCode}
                          className="min-w-0 flex-1"
                        >
                          {opt}
                        </TargetLanguageText>
                        {isCorrect && (
                          <span
                            role="img"
                            aria-label={t('correct')}
                            className="text-fl-success shrink-0"
                          >
                            <Check className="size-4" aria-hidden="true" />
                          </span>
                        )}
                        {isWrongSelection && (
                          <span
                            role="img"
                            aria-label={t('incorrect')}
                            className="text-fl-error-fg shrink-0"
                          >
                            <X className="size-4" aria-hidden="true" />
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              ) : exercise.exercise_type === 'pronunciation' ? (
                <div className="space-y-4">
                  {/* Target phrase + listen button */}
                  <div className="neu-card flex flex-wrap items-center gap-3 rounded-2xl px-4 py-4">
                    <TargetLanguageText
                      languageCode={targetLanguageCode}
                      className="text-fl-fg flex-1 font-bold"
                    >
                      {exercise.correct_answer}
                    </TargetLanguageText>
                    <AudioPlayer
                      text={exercise.correct_answer}
                      studyPlanId={lesson?.study_plan_id}
                      size="md"
                    />
                  </div>
                  {exercise.options?.[0] && (
                    <TargetLanguageText
                      as="p"
                      languageCode={targetLanguageCode}
                      className="text-fl-muted-1"
                    >
                      {exercise.options[0]}
                    </TargetLanguageText>
                  )}
                  {!isEvaluated && !isReview && lesson && (
                    <VoiceRecorder
                      studyPlanId={lesson.study_plan_id}
                      onTranscription={(text) => submitAnswer(text)}
                      maxSeconds={8}
                      disabled={evaluating}
                    />
                  )}
                  {evaluating && (
                    <p className="text-fl-hint text-fl-muted-3 animate-pulse font-mono tracking-widest uppercase">
                      {tCommon('checking')}
                    </p>
                  )}
                </div>
              ) : (
                <div className="relative">
                  {showAnnotatedAnswer && answerSegments ? (
                    <div
                      className={cn(
                        getTargetLanguageTextClass(targetLanguageCode),
                        'bg-fl-bg text-fl-fg min-h-[90px] w-full border px-4 py-3 pr-10 whitespace-pre-wrap',
                        isAnswerCorrect
                          ? 'border-fl-success/50'
                          : isPartiallyCorrect
                            ? 'border-fl-warning/50'
                            : 'border-fl-error-fg/50'
                      )}
                    >
                      {answerSegments.map((segment, index) =>
                        segment.type === 'plain' ? (
                          <span key={index}>{segment.text}</span>
                        ) : (
                          <span key={index}>
                            <del className="text-fl-error-fg decoration-fl-error-fg/70 line-through">
                              {segment.original}
                            </del>{' '}
                            <ins className="text-fl-success decoration-fl-success/70 font-semibold">
                              {segment.corrected}
                            </ins>
                          </span>
                        )
                      )}
                    </div>
                  ) : (
                    <textarea
                      className={cn(
                        getTargetLanguageTextClass(targetLanguageCode),
                        'neu-input text-fl-fg placeholder:text-fl-muted-4 min-h-[96px] w-full resize-y rounded-2xl px-4 py-3 font-medium transition-all focus:outline-none disabled:opacity-100',
                        isEvaluated && 'pr-10',
                        isEvaluated &&
                        (isAnswerCorrect
                          ? 'border-fl-success/50'
                          : isPartiallyCorrect
                            ? 'border-fl-warning/50'
                            : 'border-fl-error-fg/50')
                      )}
                      placeholder={t('yourAnswer')}
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                      disabled={isEvaluated || isReview}
                    />
                  )}
                  {isEvaluated && (
                    <span
                      role="img"
                      aria-label={
                        isAnswerCorrect
                          ? t('correct')
                          : isPartiallyCorrect
                            ? t('corrections')
                            : t('incorrect')
                      }
                      className={`absolute top-3 right-3 ${isAnswerCorrect
                          ? 'text-fl-success'
                          : isPartiallyCorrect
                            ? 'text-fl-warning'
                            : 'text-fl-error-fg'
                        }`}
                    >
                      {isAnswerCorrect ? (
                        <Check className="size-4" aria-hidden="true" />
                      ) : isPartiallyCorrect ? (
                        <Diff className="size-4" aria-hidden="true" />
                      ) : (
                        <X className="size-4" aria-hidden="true" />
                      )}
                    </span>
                  )}
                </div>
              )}

              {!isEvaluated && !isReview ? (
                exercise.exercise_type !== 'pronunciation' ? (
                  <>
                    <button
                      onClick={() => submitAnswer()}
                      disabled={evaluating || !answer.trim()}
                      className="neu-button-primary w-full rounded-xl py-3.5 font-mono text-sm font-bold tracking-widest uppercase transition-all disabled:opacity-40"
                    >
                      {evaluating ? tCommon('checking') : t('submitAnswer')}
                    </button>
                    {submitError && (
                      <p className="text-fl-error font-mono text-xs font-semibold">
                        {tError('title')}
                      </p>
                    )}
                  </>
                ) : null
              ) : (
                <div className="space-y-4">
                  {exercise.feedback && (
                    <div className="neu-card rounded-2xl px-4 py-4">
                      <p className="text-fl-label text-fl-muted-2 mb-2 font-mono font-semibold tracking-widest uppercase">
                        {t('feedback')}
                      </p>
                      <TargetLanguageText
                        as="p"
                        languageCode={targetLanguageCode}
                        className="text-fl-muted-1 max-w-[70ch]"
                      >
                        {exercise.feedback}
                      </TargetLanguageText>
                    </div>
                  )}
                  {exerciseCorrections.length > 0 && (
                    <div className="neu-card rounded-2xl px-4 py-4">
                      <p className="text-fl-label text-fl-muted-2 mb-2 font-mono font-semibold tracking-widest uppercase">
                        {t('corrections')}
                      </p>
                      <ul className="space-y-3">
                        {exerciseCorrections.map((correction, index) => (
                          <li key={index}>
                            <p
                              className={getTargetLanguageTextClass(
                                targetLanguageCode
                              )}
                            >
                              <del className="text-fl-error-fg decoration-fl-error-fg/70 line-through">
                                {correction.original}
                              </del>
                              <span className="text-fl-muted-3"> → </span>
                              <ins className="text-fl-success decoration-fl-success/70 font-semibold">
                                {correction.corrected}
                              </ins>
                            </p>
                            {correction.explanation && (
                              <p className="text-fl-muted-2 mt-1 text-sm">
                                {correction.explanation}
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {exercise.explanation && (
                    <div className="neu-card rounded-2xl px-4 py-4">
                      <p className="text-fl-label text-fl-muted-2 mb-2 font-mono font-semibold tracking-widest uppercase">
                        {t('explanation')}
                      </p>
                      <TargetLanguageText
                        as="p"
                        languageCode={targetLanguageCode}
                        className="text-fl-muted-1 max-w-[70ch]"
                      >
                        {exercise.explanation}
                      </TargetLanguageText>
                      {exercise.native_explanation && nativeLanguageName && (
                        <div className="border-fl-border/60 mt-4 border-t pt-4">
                          <p className="text-fl-label text-fl-muted-2 mb-2 font-mono font-semibold tracking-widest uppercase">
                            {nativeLanguageName}
                          </p>
                          <p className="text-fl-muted-1 max-w-[70ch] text-base leading-relaxed">
                            {exercise.native_explanation}
                          </p>
                        </div>
                      )}
                      {!exercise.native_explanation && nativeLanguageName && (
                        <div className="border-fl-border/60 mt-4 border-t pt-4 text-center">
                          <button
                            type="button"
                            onClick={() =>
                              generateExerciseNativeExplanation(exercise.id)
                            }
                            disabled={
                              loadingExerciseNativeExplanationId === exercise.id
                            }
                            className="neu-button text-fl-hint text-fl-muted-1 hover:text-fl-fg rounded-xl px-4 py-2 font-mono text-xs font-semibold transition-all disabled:opacity-50"
                          >
                            {loadingExerciseNativeExplanationId === exercise.id
                              ? '...'
                              : exerciseNativeExplanationErrorId === exercise.id
                                ? tCommon('retry')
                                : `${t('showNativeExplanation')} ${nativeLanguageName}`}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-4">
                    <div className="neu-card rounded-xl px-4 py-2">
                      <span className="text-fl-label text-fl-muted-2 font-mono font-semibold tracking-widest uppercase">
                        {tCommon('score')}{' '}
                      </span>
                      <span className="text-fl-fg font-mono text-sm font-bold">
                        {exercise.score !== null
                          ? Math.round((exercise.score ?? 0) * 100) + '%'
                          : tCommon('notAvailable')}
                      </span>
                    </div>
                    {currentExercise < exercises.length - 1 ? (
                      <button
                        onClick={nextExercise}
                        className="neu-button text-fl-muted-1 hover:text-fl-fg rounded-xl px-6 py-2.5 font-mono text-xs font-bold tracking-widest uppercase transition-all"
                      >
                        {tCommon('next')} →
                      </button>
                    ) : isReview ? (
                      <button
                        onClick={() => router.push('/plan')}
                        className="neu-button-primary rounded-xl px-6 py-2.5 font-mono text-sm font-bold tracking-widest uppercase transition-all"
                      >
                        {t('backToPlan')}
                      </button>
                    ) : freemiumExhausted ? (
                      <PaywallBanner feature="lessons" compact />
                    ) : (
                      <button
                        onClick={completeLessonHandler}
                        disabled={completingLesson}
                        className="neu-button-primary rounded-xl px-6 py-2.5 font-mono text-sm font-bold tracking-widest uppercase transition-all disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {t('completeLesson')}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Vocabulary */}
        {(() => {
          const vocabItems = (lesson?.content?.vocabulary ??
            []) as LessonVocabularyItem[]
          if (!vocabItems.length) return null
          return (
            <div className="glass-card rounded-2xl p-5">
              <p className="text-fl-label text-fl-muted-2 mb-3 font-mono font-semibold tracking-widest uppercase">
                {t('vocabulary')}
              </p>
              <div className="space-y-3">
                {vocabItems.map((item, idx) => (
                  <div key={idx} className="neu-card rounded-2xl px-4 py-3.5">
                    <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        {item.word && (
                          <TargetLanguageText
                            as="p"
                            languageCode={targetLanguageCode}
                            className="text-fl-fg font-semibold"
                            reading={item.reading}
                          >
                            {item.word}
                          </TargetLanguageText>
                        )}
                        {item.translation && (
                          <p className="text-fl-muted-2 mt-1 text-sm font-medium">
                            {item.translation}
                          </p>
                        )}
                      </div>
                      {item.example && (
                        <AudioPlayer
                          text={item.example}
                          studyPlanId={lesson?.study_plan_id}
                          size="sm"
                        />
                      )}
                    </div>
                    {item.definition && (
                      <TargetLanguageText
                        as="p"
                        languageCode={targetLanguageCode}
                        className="text-fl-muted-1"
                      >
                        {item.definition}
                      </TargetLanguageText>
                    )}
                    {item.example && (
                      <div className="border-fl-border/60 mt-3 border-t pt-3">
                        <TargetLanguageText
                          as="p"
                          languageCode={targetLanguageCode}
                          className="text-fl-muted-1 italic"
                        >
                          {item.example}
                        </TargetLanguageText>
                        {item.example_translation && (
                          <p className="text-fl-hint text-fl-muted-2 mt-1 text-sm font-medium">
                            {item.example_translation}
                          </p>
                        )}
                      </div>
                    )}
                    {item.note && (
                      <p className="text-fl-hint text-fl-muted-2 mt-3 text-sm font-medium">
                        {item.note}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        })()}

        {/* Related Grammar */}
        {(() => {
          const grammarRefs = (lesson?.content?.grammar_refs ?? []) as string[]
          if (!grammarRefs.length) return null
          return (
            <div className="glass-card rounded-2xl p-5">
              <p className="text-fl-label text-fl-muted-2 mb-3 font-mono font-semibold tracking-widest uppercase">
                {t('relatedGrammar')}
              </p>
              <div className="flex flex-wrap gap-2">
                {grammarRefs.map((slug) => {
                  const topic = grammarTopics.find((t) => t.slug === slug)
                  if (!topic) return null
                  return (
                    <Link
                      key={slug}
                      href={`/grammar/${slug}`}
                      className="neu-button text-fl-label text-fl-muted-1 hover:text-fl-fg rounded-full px-3.5 py-1.5 font-mono font-semibold tracking-widest uppercase transition-all"
                    >
                      ● {topic.title}
                    </Link>
                  )
                })}
              </div>
            </div>
          )
        })()}
      </div>

      <ConfirmDialog
        open={showExitConfirm}
        title={t('exitConfirmTitle')}
        message={t('exitConfirmMessage')}
        confirmLabel={t('exit')}
        danger
        onConfirm={() => router.push('/dashboard')}
        onCancel={() => setShowExitConfirm(false)}
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
    </>
  )
}
