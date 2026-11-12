'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { apiFetch } from '@/lib/api'
import { PageLoading } from '@/components/ui/page-loading'
import { useAuthStore } from '@/store/auth'
import { type QuotaStatus } from '@/types/api'

export function UsageLimitsSection({ title }: { title?: string } = {}) {
  const t = useTranslations('settings')
  const tCommon = useTranslations('common')
  const sessionVersion = useAuthStore((s) => s.sessionVersion)
  const [quota, setQuota] = useState<QuotaStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setQuota(null)
    setFailed(false)
    const timeout = setTimeout(() => {
      controller.abort()
      setFailed(true)
    }, 20_000)
    apiFetch('/api/auth/quota', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error('Quota unavailable')
        return res.json()
      })
      .then((data: QuotaStatus) => {
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          throw new Error('Invalid quota response')
        }
        if (!controller.signal.aborted) setQuota(data)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
      .finally(() => clearTimeout(timeout))
    return () => {
      clearTimeout(timeout)
      controller.abort()
    }
  }, [attempt, sessionVersion])

  return (
    <div className="glass-card rounded-2xl p-6">
      <div className="border-fl-border/60 mb-5 flex items-center gap-2 border-b pb-4">
        <span className="text-fl-accent text-fl-label">●</span>
        <span className="text-fl-label text-fl-fg font-mono font-bold tracking-widest uppercase">
          {title ?? t('sectionUsageLimits')}
        </span>
      </div>
      {failed ? (
        <div className="space-y-3">
          <p role="alert" className="text-fl-error-fg text-sm font-semibold">
            {tCommon('errorMessage')}
          </p>
          <button
            type="button"
            className="neu-button rounded-xl px-4 py-2 text-sm font-semibold"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {tCommon('retry')}
          </button>
        </div>
      ) : quota === null ? (
        <PageLoading fullScreen={false} />
      ) : (
        <div className="space-y-3">
          {[
            {
              label: t('quotaSessions'),
              used: quota.sessions_this_week,
              limit: quota.sessions_limit,
              unlimited: quota.sessions_unlimited,
              format: (v: number) => String(v),
            },
            {
              label: t('quotaMinutesDay'),
              used: quota.minutes_today,
              limit: quota.minutes_limit,
              unlimited: quota.time_unlimited,
              format: (v: number) => String(v),
            },
            {
              label: t('quotaMinutesWeek'),
              used: quota.minutes_this_week,
              limit: quota.weekly_minutes_limit,
              unlimited: quota.weekly_minutes_unlimited,
              format: (v: number) => String(v),
            },
            {
              label: t('quotaTokens'),
              used: Math.round((quota.tokens_this_month ?? 0) / 1000),
              limit: Math.round((quota.tokens_monthly_limit ?? 0) / 1000),
              unlimited: quota.tokens_unlimited ?? false,
              format: (v: number) => `${v}k`,
            },
          ].map(({ label, used, limit, unlimited, format }) => {
            const pct =
              unlimited || limit === 0
                ? null
                : Math.min(100, Math.round((used / limit) * 100))
            const exceeded = !unlimited && limit > 0 && used >= limit
            return (
              <div key={label} className="flex items-center gap-3">
                <span className="text-fl-hint text-fl-muted-2 w-36 shrink-0 font-mono font-semibold tracking-widest uppercase">
                  {label}
                </span>
                {unlimited ? (
                  <span className="text-fl-hint text-fl-fg font-mono font-semibold">
                    {t('quotaUnlimited')}
                  </span>
                ) : (
                  <>
                    <div className="bg-fl-border/60 h-2 flex-1 overflow-hidden rounded-full">
                      <div
                        className={`h-full rounded-full transition-all motion-reduce:transition-none ${exceeded ? 'bg-fl-error' : 'bg-fl-accent'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span
                      className={`text-fl-hint font-mono font-semibold tabular-nums ${exceeded ? 'text-fl-error' : 'text-fl-fg'}`}
                    >
                      {format(used)}&thinsp;/&thinsp;{format(limit)}
                    </span>
                  </>
                )}
              </div>
            )
          })}
          <p className="text-fl-hint text-fl-muted-2 pt-1 font-mono font-medium">
            {t('quotaHint')}
          </p>
        </div>
      )}
    </div>
  )
}
