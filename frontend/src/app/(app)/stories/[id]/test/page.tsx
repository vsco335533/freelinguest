'use client'

import { useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { CheckCircle2, XCircle } from 'lucide-react'
import { PageLoading } from '@/components/ui/page-loading'
import { TargetLanguageText } from '@/components/TargetLanguageText'
import { apiFetch } from '@/lib/api'
import { useLanguageStore } from '@/store/language'

interface Question {
  index: number
  type: 'choice' | 'short'
  question: string
  options: string[]
}

interface StoryTest {
  attempt_id: number
  story_id: number
  pass_score: number
  questions: Question[]
}

interface ResultItem {
  index: number
  your_answer: string
  correct_answer: string
  correct: boolean
  feedback: string
}

interface TestResult {
  score: number
  passed: boolean
  pass_score: number
  level: string
  level_up: boolean
  next_story_id: number | null
  results: ResultItem[]
}

export default function StoryTestPage() {
  const t = useTranslations('stories')
  const tCommon = useTranslations('common')
  const params = useParams<{ id: string }>()
  const storyId = Number(params.id)
  const languageCode = useLanguageStore((s) => s.activeLanguage?.code)
  const [test, setTest] = useState<StoryTest | null>(null)
  const [answers, setAnswers] = useState<string[]>([])
  const [result, setResult] = useState<TestResult | null>(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const started = useRef(-1)

  useEffect(() => {
    // One generated test per attempt, even under React strict-mode double effects.
    if (started.current === attempt) return
    started.current = attempt
    setError('')
    setTest(null)
    setResult(null)
    apiFetch(`/api/stories/${storyId}/test`, { method: 'POST' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const data: StoryTest = await res.json()
        setTest(data)
        setAnswers(data.questions.map(() => ''))
      })
      .catch(() => setError(t('testLoadError')))
  }, [storyId, attempt, t])

  async function submit() {
    if (!test) return
    setSubmitting(true)
    setError('')
    try {
      const res = await apiFetch(`/api/stories/${storyId}/test/${test.attempt_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      })
      if (!res.ok) throw new Error()
      setResult(await res.json())
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch {
      setError(t('testSubmitError'))
    } finally {
      setSubmitting(false)
    }
  }

  if (error && !test) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 p-6">
        <p role="alert" className="text-fl-muted-1 font-sans text-sm">
          {error}
        </p>
        <button
          type="button"
          className="text-fl-accent font-sans text-sm underline"
          onClick={() => setAttempt((n) => n + 1)}
        >
          {tCommon('retry')}
        </button>
        <Link href="/stories" className="text-fl-muted-1 font-sans text-sm underline">
          {t('backToStories')}
        </Link>
      </div>
    )
  }
  if (!test) return <PageLoading />

  const resultByIndex = new Map(result?.results.map((r) => [r.index, r]))
  const allAnswered = answers.every((a) => a.trim().length > 0)

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <Link href="/stories" className="text-fl-muted-1 font-sans text-sm underline">
        {t('backToStories')}
      </Link>
      <header className="space-y-1">
        <h1 className="text-fl-fg font-sans text-2xl font-bold">{t('testTitle')}</h1>
        <p className="text-fl-muted-1 font-sans text-sm">
          {t('testIntro', { pass: test.pass_score })}
        </p>
      </header>

      {result && (
        <div role="status" className="glass-card animate-in fade-in space-y-2 rounded-2xl p-5">
          <p className="text-fl-fg font-mono text-3xl font-bold">{result.score}%</p>
          <p className="text-fl-fg font-sans text-sm font-semibold">
            {result.passed ? t('testPassed') : t('testFailed', { pass: result.pass_score })}
          </p>
          {result.level_up && (
            <p className="text-fl-accent font-sans text-sm font-semibold">
              {t('levelUp', { level: result.level })}
            </p>
          )}
          <div className="flex flex-wrap gap-2 pt-2">
            {result.passed && result.next_story_id !== null && (
              <Link
                href={`/stories/${result.next_story_id}`}
                className="neu-button-primary rounded-xl px-4 py-2 font-mono text-xs font-bold tracking-widest uppercase"
              >
                {t('nextStory')}
              </Link>
            )}
            {!result.passed && (
              <button
                type="button"
                className="neu-button-primary rounded-xl px-4 py-2 font-mono text-xs font-bold tracking-widest uppercase"
                onClick={() => setAttempt((n) => n + 1)}
              >
                {t('retakeTest')}
              </button>
            )}
            <Link
              href={`/stories/${storyId}`}
              className="neu-button rounded-xl px-4 py-2 font-mono text-xs font-bold tracking-widest uppercase"
            >
              {t('replay')}
            </Link>
          </div>
        </div>
      )}

      <ol className="space-y-4">
        {test.questions.map((q) => {
          const r = resultByIndex.get(q.index)
          return (
            <li key={q.index} className="glass-card space-y-3 rounded-2xl p-4">
              <TargetLanguageText as="p" languageCode={languageCode} className="text-fl-fg font-semibold">
                {q.index + 1}. {q.question}
              </TargetLanguageText>
              {q.type === 'choice' ? (
                <div className="space-y-2">
                  {q.options.map((option) => (
                    <label key={option} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name={`q-${q.index}`}
                        value={option}
                        disabled={!!result}
                        checked={answers[q.index] === option}
                        onChange={() =>
                          setAnswers((prev) => prev.map((a, i) => (i === q.index ? option : a)))
                        }
                      />
                      <TargetLanguageText languageCode={languageCode} className="text-fl-fg text-sm">
                        {option}
                      </TargetLanguageText>
                    </label>
                  ))}
                </div>
              ) : (
                <input
                  className="border-fl-border bg-fl-bg text-fl-fg w-full rounded-xl border px-3 py-2 font-sans text-sm"
                  value={answers[q.index]}
                  maxLength={500}
                  disabled={!!result}
                  placeholder={t('shortAnswerPlaceholder')}
                  onChange={(e) =>
                    setAnswers((prev) =>
                      prev.map((a, i) => (i === q.index ? e.target.value : a))
                    )
                  }
                />
              )}
              {r && (
                <div className="flex items-start gap-2 text-sm">
                  {r.correct ? (
                    <CheckCircle2 className="text-fl-accent mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  ) : (
                    <XCircle className="text-fl-error mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  )}
                  <div className="space-y-1">
                    {!r.correct && (
                      <p className="text-fl-fg">
                        {t('correctAnswer')}:{' '}
                        <TargetLanguageText languageCode={languageCode}>
                          {r.correct_answer}
                        </TargetLanguageText>
                      </p>
                    )}
                    {r.feedback && <p className="text-fl-muted-1">{r.feedback}</p>}
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ol>

      {!result && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={submitting || !allAnswered}
            className="neu-button-primary rounded-xl px-5 py-2 font-mono text-xs font-bold tracking-widest uppercase disabled:opacity-50"
            onClick={() => void submit()}
          >
            {submitting ? t('checking') : t('submitTest')}
          </button>
          {error && (
            <p role="alert" className="text-fl-error text-sm">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
