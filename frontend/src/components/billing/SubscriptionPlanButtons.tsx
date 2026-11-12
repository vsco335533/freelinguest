'use client'

import { useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { createCheckout } from '@/lib/billing'
import { splitYearlyCta, type BillingInterval } from '@/lib/billing-copy'
import { useConfigStore } from '@/store/config'
import { useAuthStore } from '@/store/auth'

interface SubscriptionPlanButtonsProps {
  className?: string
}

export function SubscriptionPlanButtons({
  className = '',
}: SubscriptionPlanButtonsProps) {
  const tBilling = useTranslations('billing')
  const locale = useLocale()
  const priceMonthly = useConfigStore((s) => s.priceMonthly)
  const priceYearly = useConfigStore((s) => s.priceYearly)
  const [loading, setLoading] = useState<BillingInterval | null>(null)
  const [error, setError] = useState<string | null>(null)
  const checkoutRequest = useRef<AbortController | null>(null)
  useEffect(() => () => checkoutRequest.current?.abort(), [])
  const yearlyCta = splitYearlyCta(
    tBilling('planYearly', {
      price: new Intl.NumberFormat(locale).format(priceYearly),
    })
  )

  async function startCheckout(plan: BillingInterval) {
    if (loading) return
    const controller = new AbortController()
    checkoutRequest.current = controller
    const { sessionVersion } = useAuthStore.getState()
    const obsolete = () =>
      controller.signal.aborted ||
      useAuthStore.getState().sessionVersion !== sessionVersion
    setLoading(plan)
    setError(null)
    try {
      const url = await createCheckout(plan, controller.signal)
      if (obsolete()) return
      if (url) window.location.assign(url)
    } catch {
      if (obsolete()) return
      setError(tBilling('checkoutError'))
    } finally {
      if (!obsolete()) setLoading(null)
    }
  }

  return (
    <div className={`space-y-3 ${className}`}>
      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={() => startCheckout('yearly')}
          disabled={loading !== null}
          className="neu-button-primary flex-1 rounded-xl px-4 py-3 font-mono text-sm font-bold tracking-widest uppercase transition-all disabled:opacity-50"
        >
          {loading === 'yearly' ? (
            '...'
          ) : (
            <span className="flex flex-col items-center gap-0.5 leading-relaxed">
              <span>{yearlyCta.main}</span>
              {yearlyCta.savings && (
                <span className="text-fl-accent-fg text-xs font-semibold">
                  {yearlyCta.savings}
                </span>
              )}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => startCheckout('monthly')}
          disabled={loading !== null}
          className="neu-button text-fl-fg flex-1 rounded-xl px-4 py-3 font-mono text-sm font-bold tracking-widest uppercase transition-all disabled:opacity-50"
        >
          {loading === 'monthly'
            ? '...'
            : tBilling('planMonthly', {
                price: new Intl.NumberFormat(locale).format(priceMonthly),
              })}
        </button>
      </div>
      {error && <p className="text-fl-error font-mono text-xs">{error}</p>}
    </div>
  )
}
