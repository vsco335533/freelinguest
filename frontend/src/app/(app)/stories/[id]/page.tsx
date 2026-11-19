/**
 * /stories/[id] — Story-based conversation on one screen: the current paragraph, story
 * progress (paragraph steps and conversation time) and the story so far on the left; the
 * voice conversation with its always-visible mic status and controls on the right. The
 * backend moves to the next paragraph after the fixed conversation time.
 */
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import { Check, Lightbulb, Lock, ScrollText } from 'lucide-react'
import { PageLoading } from '@/components/ui/page-loading'
import { AudioPlayer } from '@/components/ui/AudioPlayer'
import { MaintenanceGate } from '@/components/billing/MaintenanceBanner'
import { TargetLanguageText } from '@/components/TargetLanguageText'
import { apiFetch } from '@/lib/api'
import type {
  StoryCompleteMessage,
  StoryParagraphMessage,
  StoryProgressMessage,
  StoryTranslationMessage,
} from '@/lib/conversation-ws'
import { useLanguageStore } from '@/store/language'

const ConversationMode = dynamic(
  () => import('@/components/conversation/ConversationMode'),
  { ssr: false, loading: () => <PageLoading /> }
)

interface StoryDetail {
  id: number
  title: string
  cefr_level: string
  paragraph_count: number
  state: string
  current_paragraph: number
  paragraphs: string[]
  study_plan_id: number
  paragraph_seconds: number
  required_seconds: number
  locked_lengths: number[]
  native_language: string
  translations: (string | null)[]
}

export default function StoryConversationPage() {
  const t = useTranslations('stories')
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const languageCode = useLanguageStore((s) => s.activeLanguage?.code)
  const storyId = Number(params.id)
  const [story, setStory] = useState<StoryDetail | null>(null)
  const [failed, setFailed] = useState(false)
  // Paragraph texts the learner has reached, by index.
  const [known, setKnown] = useState<string[]>([])
  const [current, setCurrent] = useState(0)
  const [seconds, setSeconds] = useState(0)
  const [required, setRequired] = useState(420)
  const [complete, setComplete] = useState<StoryCompleteMessage | null>(null)
  // Character counts of paragraphs not reached yet, by index (drawn as blurred lines).
  const [lockedLengths, setLockedLengths] = useState<Record<number, number>>({})
  // The paragraph in the learner's native language, by index (bilingual learners).
  const [translations, setTranslations] = useState<Record<number, string>>({})
  const [nativeLanguage, setNativeLanguage] = useState('')

  useEffect(() => {
    if (!Number.isSafeInteger(storyId) || storyId <= 0) {
      setFailed(true)
      return
    }
    const controller = new AbortController()
    apiFetch(`/api/stories/${storyId}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error()
        return res.json()
      })
      .then((data: StoryDetail) => {
        if (data.state === 'test_ready') {
          router.replace(`/stories/${storyId}/test`)
          return
        }
        setStory(data)
        setKnown(data.paragraphs)
        setNativeLanguage(data.native_language)
        setTranslations(
          Object.fromEntries(
            data.translations
              .map((text, i) => [i, text] as const)
              .filter((entry): entry is readonly [number, string] => !!entry[1])
          )
        )
        setLockedLengths(
          Object.fromEntries(
            data.locked_lengths.map((length, i) => [data.paragraphs.length + i, length])
          )
        )
        // A passed story is replayed from the beginning.
        setCurrent(data.state === 'passed' ? 0 : Math.max(0, data.paragraphs.length - 1))
        setSeconds(data.paragraph_seconds)
        setRequired(data.required_seconds)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
  }, [storyId, router])

  const handleParagraph = useCallback((message: StoryParagraphMessage) => {
    setKnown((prev) => {
      const next = [...prev]
      next[message.index] = message.text
      return next
    })
    setCurrent(message.index)
    setSeconds(message.seconds)
    setRequired(message.required_seconds)
  }, [])

  const handleProgress = useCallback((message: StoryProgressMessage) => {
    setCurrent(message.index)
    setSeconds(message.seconds)
    setRequired(message.required_seconds)
  }, [])

  const handleTranslation = useCallback((message: StoryTranslationMessage) => {
    setNativeLanguage(message.language)
    setTranslations((prev) => ({ ...prev, [message.index]: message.text }))
  }, [])

  const [openingTest, setOpeningTest] = useState(false)
  const completeRef = useRef<StoryCompleteMessage | null>(null)
  const handleSessionEnded = useCallback(() => {
    // The story is over: go straight to the test (a replay returns to the stories list).
    const finished = completeRef.current
    setOpeningTest(true)
    window.setTimeout(() => {
      router.push(finished?.replay ? '/stories' : `/stories/${storyId}/test`)
    }, 2500)
  }, [router, storyId])

  const handleComplete = useCallback((message: StoryCompleteMessage) => {
    completeRef.current = message
    setComplete(message)
    setSeconds((value) => Math.max(value, required))
  }, [required])

  if (failed) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 p-6">
        <p role="alert" className="text-fl-muted-1 font-sans text-sm">
          {t('unavailable')}
        </p>
        <Link href="/stories" className="text-fl-accent font-sans text-sm underline">
          {t('backToStories')}
        </Link>
      </div>
    )
  }
  if (!story) return <PageLoading />

  const total = story.paragraph_count
  const text = known[current] ?? ''
  const nativeText = translations[current]
  const earlier = known.slice(0, current).filter(Boolean)
  const upcoming = Array.from({ length: Math.max(0, total - current - 1) }, (_, i) => {
    const index = current + 1 + i
    return { index, length: known[index]?.length ?? lockedLengths[index] ?? 240 }
  })
  const requiredMinutes = Math.round(required / 60)
  const doneMinutes = Math.min(requiredMinutes, Math.floor(seconds / 60))
  const percent = Math.min(100, Math.round((seconds / Math.max(1, required)) * 100))

  return (
    <MaintenanceGate>
      <div className="flex h-full min-h-0 flex-col gap-3 p-3 md:p-4 lg:flex-row lg:gap-5">
        <aside className="flex max-h-[40%] min-h-0 shrink-0 flex-col gap-3 overflow-y-auto lg:max-h-none lg:w-[42%] lg:max-w-2xl lg:overflow-visible">
          <div className="flex shrink-0 items-center justify-between gap-3">
            <Link href="/stories" className="text-fl-muted-1 font-sans text-sm underline">
              {t('backToStories')}
            </Link>
            <span className="text-fl-muted-2 font-mono text-xs">{story.cefr_level}</span>
          </div>

          {/* Current paragraph: text and audio */}
          <section
            aria-live="polite"
            className="glass-card shrink-0 space-y-3 rounded-2xl p-5 lg:max-h-[45%] lg:overflow-y-auto"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <TargetLanguageText
                  as="h1"
                  languageCode={languageCode}
                  className="text-fl-fg text-xl font-bold"
                >
                  {story.title}
                </TargetLanguageText>
                <p className="text-fl-muted-2 mt-1 font-mono text-xs tracking-widest uppercase">
                  {t('paragraphOf', { number: current + 1, total })}
                </p>
              </div>
              {text && (
                <AudioPlayer
                  key={current}
                  text={text}
                  studyPlanId={story.study_plan_id}
                  size="sm"
                  listenLabel={t('listenAgain')}
                />
              )}
            </div>
            {/* Re-keyed per paragraph so each new paragraph animates in. */}
            <TargetLanguageText
              key={current}
              as="p"
              languageCode={languageCode}
              className="text-fl-fg animate-in fade-in slide-in-from-bottom-4 text-lg leading-relaxed duration-700"
            >
              {text}
            </TargetLanguageText>
            {nativeText && (
              <div
                key={`native-${current}`}
                className="border-fl-border/60 animate-in fade-in space-y-2 border-t pt-3 duration-700"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-fl-muted-2 font-mono text-xs tracking-widest uppercase">
                    {t('inYourLanguage')}
                  </p>
                  <AudioPlayer
                    text={nativeText}
                    studyPlanId={story.study_plan_id}
                    size="sm"
                    listenLabel={t('listenAgain')}
                  />
                </div>
                <p lang={nativeLanguage} className="text-fl-muted-1 text-base leading-relaxed">
                  {nativeText}
                </p>
              </div>
            )}
          </section>

          {/* Story progress: paragraph steps and conversation time on this paragraph */}
          <section className="glass-card shrink-0 space-y-3 rounded-2xl p-4">
            <p className="text-fl-muted-2 font-mono text-xs font-bold tracking-widest uppercase">
              {t('progressTitle')}
            </p>
            <ol className="flex items-center gap-2" aria-label={t('progressTitle')}>
              {Array.from({ length: total }, (_, i) => {
                const done = i < current || (complete !== null && i === current)
                const isCurrent = i === current && !done
                return (
                  <li key={i} className="flex flex-1 items-center gap-2">
                    <span
                      aria-current={isCurrent ? 'step' : undefined}
                      className={`flex size-8 shrink-0 items-center justify-center rounded-full border font-mono text-xs font-bold transition-colors ${
                        done
                          ? 'border-fl-accent bg-fl-accent text-white'
                          : isCurrent
                            ? 'border-fl-accent text-fl-accent ring-fl-accent/30 ring-4'
                            : 'border-fl-border text-fl-muted-3'
                      }`}
                    >
                      {done ? (
                        <Check className="size-4" aria-hidden="true" />
                      ) : i > current ? (
                        <Lock className="size-3.5" aria-hidden="true" />
                      ) : (
                        i + 1
                      )}
                    </span>
                    {i < total - 1 && (
                      <span
                        className={`h-0.5 flex-1 rounded-full ${i < current ? 'bg-fl-accent' : 'bg-fl-border'}`}
                      />
                    )}
                  </li>
                )
              })}
            </ol>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-fl-fg font-sans text-sm">
                  {complete
                    ? t('storyFinishedShort')
                    : t('minutesOnParagraph', { done: doneMinutes, total: requiredMinutes })}
                </span>
                {!complete && percent >= 85 && (
                  <span className="text-fl-accent font-sans text-xs font-semibold">
                    {t('nextParagraphSoon')}
                  </span>
                )}
              </div>
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={complete ? 100 : percent}
                className="bg-fl-border/60 h-2 overflow-hidden rounded-full"
              >
                <div
                  className="bg-fl-accent h-full rounded-full transition-all duration-700"
                  style={{ width: `${complete ? 100 : percent}%` }}
                />
              </div>
            </div>
          </section>

          {complete && (
            <div
              role="status"
              className="glass-card animate-in fade-in flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-2xl p-4 duration-500"
            >
              <p className="text-fl-fg font-sans text-sm font-semibold">
                {openingTest && !complete.replay
                  ? t('openingTest')
                  : complete.replay
                    ? t('replayFinished')
                    : t('storyFinished')}
              </p>
              <Link
                href={complete.replay ? '/stories' : `/stories/${storyId}/test`}
                className="neu-button-primary rounded-xl px-4 py-2 font-mono text-xs font-bold tracking-widest uppercase"
              >
                {complete.replay ? t('backToStories') : t('takeTest')}
              </Link>
            </div>
          )}

          {/* Story so far, or speaking tips on the first paragraph */}
          <section className="glass-card min-h-0 flex-1 space-y-3 overflow-y-auto rounded-2xl p-4">
            {earlier.length > 0 ? (
              <>
                <p className="text-fl-muted-2 flex items-center gap-2 font-mono text-xs font-bold tracking-widest uppercase">
                  <ScrollText className="size-4" aria-hidden="true" />
                  {t('storySoFar')}
                </p>
                <ol className="space-y-3">
                  {earlier.map((paragraphText, i) => (
                    <li key={i} className="border-fl-border/60 border-l-2 pl-3">
                      <p className="text-fl-muted-2 font-mono text-[11px] uppercase">
                        {t('paragraphOf', { number: i + 1, total })}
                      </p>
                      <TargetLanguageText
                        as="p"
                        languageCode={languageCode}
                        className="text-fl-muted-1 text-sm leading-relaxed"
                      >
                        {paragraphText}
                      </TargetLanguageText>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <>
                <p className="text-fl-muted-2 flex items-center gap-2 font-mono text-xs font-bold tracking-widest uppercase">
                  <Lightbulb className="size-4" aria-hidden="true" />
                  {t('tipsTitle')}
                </p>
                <ul className="text-fl-muted-1 list-disc space-y-2 pl-5 font-sans text-sm leading-relaxed">
                  <li>{t('tip1')}</li>
                  <li>{t('tip2')}</li>
                  <li>{t('tip3')}</li>
                </ul>
              </>
            )}
            {upcoming.length > 0 && (
              <ol className="space-y-3 pt-1" aria-label={t('lockedParagraphs')}>
                {upcoming.map(({ index, length }) => (
                  <LockedParagraph
                    key={index}
                    label={t('paragraphOf', { number: index + 1, total })}
                    hint={t('lockedHint')}
                    length={length}
                  />
                ))}
              </ol>
            )}
          </section>
        </aside>

        <div className="glass-card flex min-h-0 min-w-0 flex-1 flex-col rounded-2xl p-3 md:p-4">
          <ConversationMode
            embedded
            storyId={storyId}
            cefrLevel={story.cefr_level}
            targetLanguage={languageCode}
            lessonTitle={story.title}
            onStoryParagraph={handleParagraph}
            onStoryProgress={handleProgress}
            onStoryTranslation={handleTranslation}
            onStoryComplete={handleComplete}
            onStorySessionEnded={handleSessionEnded}
          />
        </div>
      </div>
    </MaintenanceGate>
  )
}

/** A paragraph the learner has not reached: blurred placeholder lines under a lock. */
function LockedParagraph({
  label,
  hint,
  length,
}: {
  label: string
  hint: string
  length: number
}) {
  // About 70 characters per line; the last line is shorter, like real text.
  const lines = Math.min(8, Math.max(2, Math.ceil(length / 70)))
  return (
    <li className="border-fl-border/60 relative border-l-2 pl-3">
      <p className="text-fl-muted-3 font-mono text-[11px] uppercase">{label}</p>
      <div aria-hidden="true" className="mt-1.5 space-y-2 blur-[3px] select-none">
        {Array.from({ length: lines }, (_, i) => (
          <div
            key={i}
            className="bg-fl-muted-3/40 h-2.5 rounded-full"
            style={{ width: i === lines - 1 ? '55%' : `${92 - ((i * 7) % 14)}%` }}
          />
        ))}
      </div>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="bg-fl-bg/80 text-fl-muted-1 flex items-center gap-1.5 rounded-full px-3 py-1 font-sans text-xs font-semibold backdrop-blur-sm">
          <Lock className="size-3.5" aria-hidden="true" />
          {hint}
        </span>
      </div>
    </li>
  )
}
