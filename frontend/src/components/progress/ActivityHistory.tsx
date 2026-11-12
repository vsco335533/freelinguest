'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useAnalyticsView } from '@/hooks/useAnalyticsView'

export interface ProgressHistoryEntry {
  date: string
  xp_earned: number
}

export function ActivityHistory({
  entries,
  endDate,
}: {
  entries: ProgressHistoryEntry[]
  endDate: string
}) {
  const locale = useLocale()
  const analyticsRef = useAnalyticsView('progress_calendar_viewed')
  const t = useTranslations('progressActivity')
  const tCommon = useTranslations('common')
  const tOverview = useTranslations('dashboardProgress')
  const number = new Intl.NumberFormat(locale)
  const dateFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  })
  const weekdayFormat = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    timeZone: 'UTC',
  })
  const byDate = new Map(entries.map((entry) => [entry.date, entry]))
  // Anchor to the summary's UTC day, including days with activity but no XP.
  const days = Array.from({ length: 28 }, (_, index) => {
    const date = new Date(`${endDate}T12:00:00Z`)
    date.setUTCDate(date.getUTCDate() - 27 + index)
    const key = date.toISOString().slice(0, 10)
    return {
      date,
      key,
      active: byDate.has(key),
      xp: byDate.get(key)?.xp_earned ?? 0,
    }
  })
  const maxXp = Math.max(1, ...days.map((day) => day.xp))
  const totalXp = days.reduce((sum, day) => sum + day.xp, 0)
  const activeDays = days.filter((day) => day.active).length

  return (
    <section
      ref={analyticsRef}
      aria-labelledby="progress-history-title"
      className="space-y-4"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2
            id="progress-history-title"
            className="text-fl-fg text-lg font-semibold"
          >
            {t('title')}
          </h2>
          <p className="text-fl-muted-2 mt-1 text-sm">{t('period')}</p>
        </div>
        <p className="text-fl-muted-1 text-sm tabular-nums">
          {t('totals', {
            xp: number.format(totalXp),
            days: number.format(activeDays),
          })}
        </p>
      </div>
      <div className="glass-card space-y-5 rounded-2xl p-5">
        <div aria-hidden="true">
          <div className="flex h-24 items-end gap-1 sm:gap-2">
            {days.map((day) => (
              <div
                key={day.key}
                className={`min-w-0 flex-1 rounded-t-md ${day.xp > 0 ? 'bg-fl-accent' : 'bg-fl-border/70'}`}
                style={{ height: `${Math.max(3, (day.xp / maxXp) * 100)}%` }}
              />
            ))}
          </div>
          <div className="text-fl-muted-2 mt-2 flex justify-between gap-2 text-xs font-semibold">
            <span>{dateFormat.format(days[0].date)}</span>
            <span>{dateFormat.format(days[27].date)}</span>
          </div>
        </div>
        <div
          className="text-fl-muted-2 grid grid-cols-7 gap-1 text-center text-xs font-semibold sm:gap-2"
          aria-hidden="true"
        >
          {days.slice(0, 7).map((day) => (
            <span key={day.key}>{weekdayFormat.format(day.date)}</span>
          ))}
        </div>
        <ul aria-label={t('title')} className="grid grid-cols-7 gap-1.5 sm:gap-2">
          {days.map((day) => {
            const label = `${dateFormat.format(day.date)}: ${tOverview(day.active ? 'activeDay' : 'inactiveDay')}, ${number.format(day.xp)} ${tCommon('xpUnit')}`
            return (
              <li
                key={day.key}
                aria-label={label}
                title={label}
                className={`min-w-0 rounded-xl border px-1 py-2 text-center transition-all ${day.active ? 'neu-card border-fl-accent/40 bg-fl-accent/15 text-fl-accent' : 'border-fl-border/70 bg-fl-surface/50 text-fl-muted-2'} ${day.key === endDate ? 'ring-fl-accent/50 ring-2 ring-offset-1' : ''}`}
              >
                <span
                  aria-hidden="true"
                  className="block text-sm font-medium tabular-nums"
                >
                  {number.format(day.date.getUTCDate())}
                </span>
                <span
                  aria-hidden="true"
                  className="mt-1 block text-[10px] break-words tabular-nums sm:text-xs"
                >
                  {day.active
                    ? `${number.format(day.xp)} ${tCommon('xpUnit')}`
                    : '—'}
                </span>
              </li>
            )
          })}
        </ul>
        <p className="text-fl-muted-2 text-xs leading-relaxed">
          {t('activityHint')}
        </p>
        {activeDays === 0 && (
          <p className="text-fl-muted-1 text-sm">{t('empty')}</p>
        )}
      </div>
    </section>
  )
}
