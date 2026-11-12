'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { apiFetch } from '@/lib/api'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { PageLoading } from '@/components/ui/page-loading'

// ── Types ──────────────────────────────────────────────────────────────────────

interface LevelTestQuestion {
  id: string
  skill: string // grammar | vocabulary | reading
  difficulty: string
  question: string
  options: string[]
  correct: string
}

interface AnswerRecord {
  question_id: string
  skill: string
  difficulty: string
  correct: boolean
}

interface LevelTestResult {
  score: number // 0–1
  recommendation: 'advance' | 'extend' | 'repeat'
  next_level: string | null
}

interface SkillBreakdown {
  correct: number
  total: number
}

type FlowStep = 'loading' | 'quiz' | 'submitting' | 'result' | 'error'

// ── Helpers ────────────────────────────────────────────────────────────────────

function computeSkillBreakdown(
  questions: LevelTestQuestion[],
  answers: AnswerRecord[]
): Record<string, SkillBreakdown> {
  const map: Record<string, SkillBreakdown> = {}
  answers.forEach((a) => {
    const q = questions.find((q) => q.id === a.question_id)
    if (!q) return
    const skill = q.skill
    if (!map[skill]) map[skill] = { correct: 0, total: 0 }
    map[skill].total += 1
    if (a.correct) map[skill].correct += 1
  })
  return map
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function LevelTestPage() {
  const t = useTranslations('assessment')
  const router = useRouter()
  const searchParams = useSearchParams()
  const planId = searchParams.get('plan')

  const getSkillLabel = (skill: string): string => {
    const labels: Record<string, string> = {
      grammar: t('skills.grammar'),
      vocabulary: t('skills.vocabulary'),
      reading: t('skills.reading'),
    }
    return labels[skill] ?? skill
  }

  // Bug #6 fix: gate loadQuestions until user confirms the start warning
  const [startConfirmed, setStartConfirmed] = useState(false)
  const [showStartWarning, setShowStartWarning] = useState(true)

  const [step, setStep] = useState<FlowStep>('loading')
  const [questions, setQuestions] = useState<LevelTestQuestion[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [answers, setAnswers] = useState<AnswerRecord[]>([])
  const [cefrLevel, setCefrLevel] = useState('')
  const [result, setResult] = useState<LevelTestResult | null>(null)
  const [error, setError] = useState('')
  const [selectedOption, setSelectedOption] = useState<string | null>(null)
  // Bug #1 fix: renamed to avoid confusion; this tracks whether the current answer is confirmed
  const [answerConfirmed, setAnswerConfirmed] = useState(false)

  // Bug #1 fix: ref holds the always-current answers array so handleNext never uses a stale closure
  const answersRef = useRef<AnswerRecord[]>([])

  // ── Load questions ────────────────────────────────────────────────────────

  const loadQuestions = useCallback(async () => {
    // Bug #6 fix: skip network call until the user has confirmed starting
    if (!startConfirmed) return

    // Bug #5 fix: validate planId before converting to number
    const planIdNum = Number(planId)
    if (!planId || !Number.isInteger(planIdNum) || planIdNum <= 0) {
      setError(t('levelTest.invalidPlan'))
      setStep('error')
      return
    }

    try {
      const res = await apiFetch(
        `/api/assessment/level-test/questions/${planIdNum}`
      )
      if (!res.ok) throw new Error(t('levelTest.loadFailed'))
      const data = (await res.json()) as {
        plan_id: number
        cefr_level: string
        questions: LevelTestQuestion[]
      }
      if (!data.questions?.length) {
        throw new Error(t('levelTest.noQuestions'))
      }
      setQuestions(data.questions)
      setCefrLevel(data.cefr_level)
      setStep('quiz')
    } catch (err) {
      setError(
        err instanceof Error && err.message === t('levelTest.noQuestions')
          ? err.message
          : t('levelTest.loadFailed')
      )
      setStep('error')
    }
  }, [planId, startConfirmed, t])

  useEffect(() => {
    void loadQuestions()
  }, [loadQuestions])

  // ── Answer handling ───────────────────────────────────────────────────────

  function handleSelectOption(option: string) {
    if (answerConfirmed) return
    setSelectedOption(option)
  }

  function handleConfirmAnswer() {
    if (!selectedOption || answerConfirmed) return
    const q = questions[currentIndex]
    const isCorrect = selectedOption === q.correct
    setAnswerConfirmed(true)
    const record: AnswerRecord = {
      question_id: q.id,
      skill: q.skill,
      difficulty: q.difficulty,
      correct: isCorrect,
    }
    // Bug #1 fix: build the new array eagerly and store it in both state and ref.
    // handleNext reads from the ref so it always has the latest array regardless of
    // when React schedules the state update.
    const newAnswers = [...answers, record]
    setAnswers(newAnswers)
    answersRef.current = newAnswers
  }

  function handleNext() {
    if (currentIndex + 1 >= questions.length) {
      // Bug #1 fix: use the ref instead of the stale `answers` closure
      void submitTest(answersRef.current)
      return
    }
    setCurrentIndex((i) => i + 1)
    setSelectedOption(null)
    setAnswerConfirmed(false)
  }

  async function submitTest(finalAnswers: AnswerRecord[]) {
    setStep('submitting')
    // Bug #5 fix: planId already validated above; Number() is safe here
    const planIdNum = Number(planId)
    try {
      const res = await apiFetch('/api/assessment/level-test/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_id: planIdNum, answers: finalAnswers }),
      })
      if (!res.ok) throw new Error(t('levelTest.submitFailed'))
      const data = (await res.json()) as LevelTestResult
      setResult(data)
      setStep('result')
    } catch {
      setError(t('levelTest.submitFailed'))
      setStep('error')
    }
  }

  // ── Renders ───────────────────────────────────────────────────────────────

  // Start warning dialog — shown before any loading begins
  if (showStartWarning) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <ConfirmDialog
          open={true}
          title={t('startWarningTitle')}
          message={t('startWarningMessageLevelTest')}
          confirmLabel={t('startWarningConfirm')}
          onConfirm={() => {
            setShowStartWarning(false)
            setStartConfirmed(true)
          }}
          onCancel={() => router.push('/plan')}
        />
      </div>
    )
  }

  if (step === 'loading' || step === 'submitting') {
    return (
      <PageLoading
        label={
          step === 'loading'
            ? t('levelTest.loadingTest')
            : t('levelTest.submittingTest')
        }
      />
    )
  }

  if (step === 'error') {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="neu-glass-card w-full max-w-md overflow-hidden rounded-3xl">
          <div className="border-fl-border/60 flex items-center gap-2 border-b px-6 py-4">
            <span className="text-fl-label text-fl-accent font-bold">●</span>
            <span className="text-fl-label text-fl-muted-2 font-mono font-bold tracking-widest uppercase">
              {t('levelTest.title')}
            </span>
          </div>
          <div className="space-y-6 p-8">
            <p className="font-mono text-xs leading-relaxed font-semibold text-red-500">
              {error}
            </p>
            <button
              onClick={() => router.push('/plan')}
              className="neu-button text-fl-fg w-full rounded-xl py-3 font-mono text-xs font-bold tracking-widest uppercase"
            >
              ← {t('levelTest.result.back')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (step === 'result' && result) {
    const pct = Math.round(result.score * 100)
    const breakdown = computeSkillBreakdown(questions, answers)
    const weakAreas = Object.entries(breakdown)
      .filter(([, v]) => v.total > 0 && v.correct / v.total < 0.6)
      .map(([skill]) => getSkillLabel(skill))

    const recConfig: Record<
      LevelTestResult['recommendation'],
      {
        icon: string
        label: string
        message: string
        nextAction: string
        nextLabel: string
      }
    > = {
      advance: {
        icon: '🎉',
        label: t('levelTest.advanceLabel', {
          level: result.next_level ?? t('levelTest.nextLevelFallback'),
        }),
        message: t('levelTest.advanceMessage', {
          level: cefrLevel,
          next: result.next_level ?? t('levelTest.nextLevelFallback'),
        }),
        nextAction: result.next_level ? '/assessment' : '/plan',
        nextLabel: result.next_level
          ? `${t('retake')} →`
          : t('levelTest.goToPlan'),
      },
      extend: {
        icon: '⚠',
        label: t('levelTest.extendLabel'),
        message: t('levelTest.extendMessage', {
          areas: weakAreas.join(', ') || t('skills.reading'),
        }),
        nextAction: '/plan',
        nextLabel: t('levelTest.reviewPlan'),
      },
      repeat: {
        icon: '↺',
        label: t('levelTest.repeatLabel', { level: cefrLevel }),
        message: t('levelTest.repeatMessage', { level: cefrLevel }),
        nextAction: '/plan',
        nextLabel: t('levelTest.reviewPlan'),
      },
    }

    const rec = recConfig[result.recommendation]

    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="neu-glass-card w-full max-w-lg overflow-hidden rounded-3xl">
          {/* Header */}
          <div className="border-fl-border/60 flex items-center justify-between border-b px-6 py-4">
            <div className="flex items-center gap-2">
              <span className="text-fl-label text-fl-accent font-bold">●</span>
              <span className="text-fl-label text-fl-muted-2 font-mono font-bold tracking-widest uppercase">
                {t('levelTest.resultsTitle', { level: cefrLevel })}
              </span>
            </div>
          </div>

          <div className="space-y-6 p-8">
            {/* Score */}
            <div className="space-y-2 text-center">
              <p className="text-fl-label text-fl-muted-3 font-mono font-bold tracking-widest uppercase">
                {t('levelTest.finalScore')}
              </p>
              <p className="text-fl-fg font-mono text-7xl font-bold tracking-widest">
                {pct}%
              </p>
              <p className="text-fl-muted-2 font-mono text-xs font-semibold">
                {t('levelTest.correctCount', {
                  correct: answers.filter((a) => a.correct).length,
                  total: questions.length,
                })}
              </p>
            </div>

            {/* Skill breakdown */}
            <div className="space-y-2">
              {Object.entries(breakdown).map(([skill, v]) => {
                const skillPct =
                  v.total > 0 ? Math.round((v.correct / v.total) * 100) : 0
                const isWeak = skillPct < 60
                const label = getSkillLabel(skill)
                return (
                  <div key={skill} className="flex items-center gap-3">
                    <span className="text-fl-label text-fl-muted-3 w-6 text-center font-mono font-bold uppercase">
                      {label[0]?.toUpperCase() ?? '?'}
                    </span>
                    <span className="text-fl-label text-fl-muted-2 w-24 font-mono font-semibold tracking-widest uppercase">
                      {label}
                    </span>
                    <div className="bg-fl-border/60 h-2 flex-1 overflow-hidden rounded-full">
                      <div
                        className={`h-full rounded-full transition-all ${isWeak ? 'bg-amber-500' : 'bg-fl-accent'}`}
                        style={{ width: `${skillPct}%` }}
                      />
                    </div>
                    <span
                      className={`text-fl-label w-16 text-right font-mono font-semibold ${isWeak ? 'text-amber-500' : 'text-fl-fg'}`}
                    >
                      {v.correct}/{v.total} ({skillPct}%)
                      {isWeak && ' ◂'}
                    </span>
                  </div>
                )
              })}
            </div>

            {/* Recommendation */}
            <div className="glass-card space-y-3 rounded-2xl p-6">
              <div className="flex items-center gap-2">
                <span className="text-xl">{rec.icon}</span>
                <span className="text-fl-label text-fl-fg font-mono font-bold tracking-widest uppercase">
                  {t('levelTest.result.recommendation')}: {rec.label}
                </span>
              </div>
              <p className="text-fl-muted-2 font-mono text-xs leading-relaxed font-medium">
                {rec.message}
              </p>
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-2.5">
              <button
                onClick={() => router.push(rec.nextAction)}
                className="neu-button-primary w-full rounded-xl py-3.5 font-mono text-sm font-bold tracking-widest text-white uppercase"
              >
                {rec.nextLabel}
              </button>
              <button
                onClick={() => router.push('/plan')}
                className="neu-button text-fl-muted-1 hover:text-fl-fg w-full rounded-xl py-3 font-mono text-xs font-bold tracking-widest uppercase"
              >
                ← {t('levelTest.result.back')}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Quiz step ─────────────────────────────────────────────────────────────

  const q = questions[currentIndex]
  if (!q) return null

  const progress = (currentIndex / questions.length) * 100
  const skillLabel = getSkillLabel(q.skill)

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="neu-glass-card w-full max-w-lg rounded-3xl">
        {/* Header */}
        <div className="border-fl-border/60 space-y-3 border-b px-6 py-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-fl-accent text-fl-label">●</span>
              <span className="text-fl-label text-fl-fg font-mono font-bold tracking-widest uppercase">
                {t('levelTest.quizTitle', { level: cefrLevel })}
              </span>
            </div>
            <span className="text-fl-label text-fl-muted-2 font-mono font-semibold tracking-widest uppercase">
              {currentIndex + 1} / {questions.length}
            </span>
          </div>
          {/* Progress bar */}
          <div className="bg-fl-border/60 h-1.5 overflow-hidden rounded-full">
            <div
              className="bg-fl-accent h-full rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          {/* Skill badge */}
          <div className="flex items-center gap-2">
            <span className="glass-card text-fl-label text-fl-fg rounded-full px-3 py-1 font-mono font-semibold tracking-widest uppercase">
              {skillLabel}
            </span>
            <span className="glass-card text-fl-label text-fl-muted-2 rounded-full px-3 py-1 font-mono font-semibold tracking-widest uppercase">
              {q.difficulty}
            </span>
          </div>
        </div>

        {/* Question */}
        <div className="space-y-6 p-8">
          <p className="text-fl-fg font-mono text-sm font-medium leading-relaxed">
            {q.question}
          </p>

          {/* Options */}
          <div className="space-y-2.5">
            {q.options.map((option, i) => {
              let style =
                'w-full text-left rounded-xl font-mono text-xs font-medium tracking-wide py-3.5 px-4 transition-all cursor-pointer'

              if (!answerConfirmed) {
                style +=
                  selectedOption === option
                    ? ' neu-card ring-2 ring-fl-accent/60 text-fl-fg font-semibold'
                    : ' neu-button text-fl-fg hover:text-fl-accent'
              } else {
                if (option === q.correct) {
                  style +=
                    ' glass-card border-green-500 text-green-700 dark:text-green-400 font-semibold'
                } else if (option === selectedOption && option !== q.correct) {
                  style += ' glass-card border-red-500 text-red-600 font-semibold'
                } else {
                  style += ' glass-card text-fl-muted-3 opacity-60'
                }
              }

              const prefix = ['A', 'B', 'C', 'D'][i] ?? String(i + 1)

              return (
                <button
                  key={i}
                  onClick={() => handleSelectOption(option)}
                  disabled={answerConfirmed}
                  className={style}
                >
                  <span className="text-fl-muted-3 mr-3 font-bold">
                    {prefix}.
                  </span>
                  {option}
                </button>
              )
            })}
          </div>

          {/* Confirm / Next */}
          {!answerConfirmed ? (
            <button
              onClick={handleConfirmAnswer}
              disabled={!selectedOption}
              className="neu-button-primary w-full rounded-xl py-3.5 font-mono text-sm font-bold tracking-widest uppercase transition-all disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('levelTest.confirm')}
            </button>
          ) : (
            <div className="space-y-3">
              <div
                className={`glass-card rounded-xl p-3.5 font-mono text-xs font-semibold leading-relaxed ${
                  answers.at(-1)?.correct
                    ? 'border-green-500 text-green-700 dark:text-green-400'
                    : 'border-red-500 text-red-600'
                }`}
              >
                {answers.at(-1)?.correct
                  ? t('levelTest.correctAnswer')
                  : t('levelTest.incorrectAnswer', { answer: q.correct })}
              </div>
              <button
                onClick={handleNext}
                className="neu-button-primary w-full rounded-xl py-3.5 font-mono text-sm font-bold tracking-widest uppercase transition-all"
              >
                {currentIndex + 1 >= questions.length
                  ? `${t('levelTest.submit')} →`
                  : `${t('levelTest.nextQuestion')} →`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
