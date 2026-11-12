'use client'

import { useEffect, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { Check, Circle } from 'lucide-react'
import type { CurriculumUnit } from '@/data/curriculum'
import { localizeLessonTitle, localizeUnitTitle } from '@/lib/curriculum-i18n'

interface Lesson {
  id: number | null
  title: string
  lesson_type: string
  week: number
  day: number
  unit_id?: string
  completed: boolean
  action?: 'start' | 'continue' | 'review'
}

interface Props {
  unit: CurriculumUnit
  lessons: Lesson[]
  targetLanguage?: string | null
  cefrLevel?: string | null
  onClose: () => void
  onStartLesson: (lessonId: number) => void
}

export default function UnitDrawer({
  unit,
  lessons,
  targetLanguage,
  cefrLevel,
  onClose,
  onStartLesson,
}: Props) {
  const t = useTranslations('plan')
  const tCommon = useTranslations('common')
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  // Close on Escape
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const lessonTypeLabel: Record<string, string> = {
    grammar: t('lessonTypes.grammar'),
    vocabulary: t('lessonTypes.vocabulary'),
    reading: t('lessonTypes.reading'),
    writing: t('lessonTypes.writing'),
    listening: t('lessonTypes.listening'),
    conversation: t('lessonTypes.conversation'),
    review: t('lessonTypes.review'),
    level_test: t('lessonTypes.level_test'),
  }

  return (
    <div className="bg-fl-bg/75 fixed inset-0 z-50 flex items-end justify-center p-2 backdrop-blur-md sm:items-center sm:p-4">
      <div
        ref={ref}
        className="neu-glass-card max-h-[82vh] w-full overflow-y-auto rounded-3xl sm:max-w-xl"
      >
        {/* Header */}
        <div className="glass-panel border-fl-border/60 sticky top-0 z-10 flex items-center justify-between border-b px-6 py-4">
          <div>
            <span className="text-fl-hint text-fl-muted-3 font-mono font-bold tracking-widest uppercase">
              {unit.level} · {t('unitLabel')}
            </span>
            <p className="text-fl-body text-fl-fg mt-0.5 font-mono font-bold">
              {localizeUnitTitle(
                {
                  unitId: unit.id,
                  title: unit.title,
                  cefrLevel: cefrLevel ?? unit.level,
                  targetLanguage,
                },
                tCommon
              )}
            </p>
          </div>
          <button
            onClick={onClose}
            className="neu-button text-fl-muted-2 hover:text-fl-fg flex h-9 w-9 items-center justify-center rounded-full font-mono text-base leading-none"
            aria-label={tCommon('close')}
          >
            ✕
          </button>
        </div>

        {/* Grammar points */}
        {unit.grammar_points.length > 0 && (
          <div className="border-fl-border/60 border-b px-6 py-4">
            <p className="text-fl-hint text-fl-muted-3 mb-2 font-mono font-bold tracking-widest uppercase">
              {t('grammarCovered')}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {unit.grammar_points.map((gp) => (
                <span
                  key={gp}
                  className="text-fl-hint border-fl-border/80 bg-fl-surface-2/60 text-fl-muted-1 rounded-full border px-2.5 py-1 font-mono font-semibold"
                >
                  {gp}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Lessons */}
        <div>
          <div className="border-fl-border border-b px-6 py-3">
            <p className="text-fl-hint text-fl-muted-3 font-mono tracking-widest uppercase">
              {t('lessonsHeader', { count: lessons.length })}
            </p>
          </div>
          <div className="divide-fl-border divide-y">
            {lessons.length === 0 ? (
              <div className="px-6 py-6">
                <p className="text-fl-label text-fl-muted-3 font-mono">
                  {t('noLessons')}
                </p>
              </div>
            ) : (
              lessons.map((lesson, i) => (
                <div
                  key={lesson.id ?? i}
                  className={`flex items-center gap-3 px-6 py-4 transition-colors ${lesson.action ? 'hover:bg-fl-surface-2' : ''}`}
                >
                  <span
                    role="img"
                    aria-label={t(
                      lesson.completed ? 'completed' : 'lessonPending'
                    )}
                    className={`w-4 shrink-0 font-mono text-base ${lesson.completed ? 'text-fl-fg' : 'text-fl-muted-3'}`}
                  >
                    {lesson.completed ? (
                      <Check className="size-4" aria-hidden="true" />
                    ) : (
                      <Circle className="size-4" aria-hidden="true" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className={`text-fl-label font-mono ${lesson.completed ? 'text-fl-muted-2 line-through' : 'text-fl-muted-1'}`}
                    >
                      {localizeLessonTitle(
                        {
                          title: lesson.title,
                          unitId: lesson.unit_id ?? unit.id,
                          lessonType: lesson.lesson_type,
                          cefrLevel: cefrLevel ?? unit.level,
                          targetLanguage,
                        },
                        tCommon
                      )}
                    </p>
                    <p className="text-fl-hint text-fl-muted-3 mt-0.5 font-mono">
                      {t('weekDay', { week: lesson.week, day: lesson.day })} ·{' '}
                      {lessonTypeLabel[lesson.lesson_type] ??
                        lesson.lesson_type}
                    </p>
                  </div>
                  {lesson.id != null && lesson.action && (
                    <button
                      onClick={() => onStartLesson(lesson.id!)}
                      className="neu-button-primary min-w-24 shrink-0 rounded-xl px-4 py-2 font-mono text-xs font-bold tracking-widest text-white uppercase"
                    >
                      {lesson.action === 'review'
                        ? t('reviewLesson')
                        : lesson.action === 'continue'
                          ? t('resume')
                          : `${tCommon('start')} →`}
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Close */}
        <div className="glass-panel border-fl-border/60 sticky bottom-0 border-t px-6 py-4">
          <button
            onClick={onClose}
            className="neu-button text-fl-muted-2 hover:text-fl-fg w-full rounded-xl py-3 font-mono text-xs font-bold tracking-widest uppercase"
          >
            {tCommon('close')}
          </button>
        </div>
      </div>
    </div>
  )
}
