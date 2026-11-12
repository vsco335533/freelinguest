'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import {
  BookOpen,
  GraduationCap,
  Headphones,
  MessageSquare,
  Mic,
} from 'lucide-react'
import { useBillingPortal } from '@/hooks/useBillingPortal'
import { createCheckout } from '@/lib/billing'
import { splitYearlyCta, type BillingInterval } from '@/lib/billing-copy'
import { useConfigStore } from '@/store/config'
import { useAuthStore, isSubscribed, needsPaymentRecovery } from '@/store/auth'

const PAYWALL_CONTEXT = {
  games: {
    icon: GraduationCap,
    title: 'paywallGamesTitle',
    desc: 'paywallGamesDesc',
  },
  chat: {
    icon: MessageSquare,
    title: 'paywallChatTitle',
    desc: 'paywallChatDesc',
  },
  voice: {
    icon: Mic,
    title: 'paywallConversationTitle',
    desc: 'paywallConversationDesc',
  },
  listening: {
    icon: Headphones,
    title: 'paywallListeningTitle',
    desc: 'paywallListeningDesc',
  },
  reading: {
    icon: BookOpen,
    title: 'paywallReadingTitle',
    desc: 'paywallReadingDesc',
  },
  lessons: {
    icon: GraduationCap,
    title: 'paywallLessonsTitle',
    desc: 'paywallLessonsDesc',
  },
} as const

type FeatureContext = keyof typeof PAYWALL_CONTEXT

interface PaywallBannerProps {
  feature?: FeatureContext
  compact?: boolean
}

export function PaywallBanner({
  feature = 'chat',
  compact = false,
}: PaywallBannerProps) {
  const t = useTranslations('billing')
  const locale = useLocale()
  const router = useRouter()
  const user = useAuthStore((s) => s.user)
  const stripeEnabled = useConfigStore((s) => s.stripeEnabled)
  const priceMonthly = useConfigStore((s) => s.priceMonthly)
  const priceYearly = useConfigStore((s) => s.priceYearly)
  const [loading, setLoading] = useState<BillingInterval | null>(null)
  const {
    openPortal,
    loading: portalLoading,
    error: portalError,
  } = useBillingPortal()
  const [error, setError] = useState<string | null>(null)
  const checkoutRequest = useRef<AbortController | null>(null)
  useEffect(() => () => checkoutRequest.current?.abort(), [])
  const paymentRecovery = needsPaymentRecovery(user)
  const yearlyCta = splitYearlyCta(
    t('planYearly', {
      price: new Intl.NumberFormat(locale).format(priceYearly),
    })
  )

  if (!stripeEnabled || isSubscribed(user, stripeEnabled)) return null

  const context = PAYWALL_CONTEXT[feature] ?? PAYWALL_CONTEXT.chat
  const Icon = context.icon

  async function handleCheckout(interval: BillingInterval) {
    if (loading) return
    const controller = new AbortController()
    checkoutRequest.current = controller
    const { sessionVersion } = useAuthStore.getState()
    const obsolete = () =>
      controller.signal.aborted ||
      useAuthStore.getState().sessionVersion !== sessionVersion
    setLoading(interval)
    setError(null)
    try {
      const url = await createCheckout(interval, controller.signal)
      if (obsolete()) return
      if (url) window.location.assign(url)
    } catch {
      if (obsolete()) return
      setError(t('checkoutError'))
    } finally {
      if (!obsolete()) setLoading(null)
    }
  }

  const containerClass = compact
    ? 'glass-card w-full rounded-2xl p-5 text-center'
    : 'flex min-h-[60vh] flex-col items-center justify-center px-6 py-16 text-center'

  return (
    <div className={containerClass}>
      {compact ? (
        <div className="neu-glass-card mx-auto w-full max-w-md rounded-3xl p-8">
          <PaywallContent />
        </div>
      ) : (
        <div className="neu-glass-card w-full max-w-md rounded-3xl p-8">
          <PaywallContent />
        </div>
      )}
    </div>
  )

  function PaywallContent() {
    return (
      <>
        <Icon
          className="text-fl-accent mx-auto mb-4 h-7 w-7"
          aria-hidden="true"
        />

        <p className="text-fl-label text-fl-accent mb-2 font-mono font-bold tracking-widest uppercase">
          {t('paywallLabel')}
        </p>
        <h2 className="text-fl-fg mb-3 font-mono text-base font-bold">
          {t(paymentRecovery ? 'pastDueTitle' : context.title)}
        </h2>
        <p className="text-fl-muted-2 mb-6 font-mono text-sm font-medium leading-relaxed">
          {paymentRecovery
            ? t('pastDueDesc')
            : t(context.desc ?? 'paywallDescTrialUsed')}
        </p>

        {paymentRecovery ? (
          <button
            onClick={openPortal}
            disabled={portalLoading}
            className="neu-button-primary w-full rounded-xl px-4 py-3 font-mono text-sm font-bold tracking-widest uppercase transition-all disabled:opacity-50"
          >
            {portalLoading ? '...' : t('updatePayment')}
          </button>
        ) : (
          <div className="flex flex-col gap-3">
            <button
              onClick={() => handleCheckout('yearly')}
              disabled={loading !== null}
              className="neu-button-primary w-full rounded-xl px-4 py-3 font-mono text-sm font-bold tracking-widest uppercase transition-all disabled:opacity-50"
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
              onClick={() => handleCheckout('monthly')}
              disabled={loading !== null}
              className="neu-button text-fl-fg w-full rounded-xl px-4 py-3 font-mono text-sm font-bold tracking-widest uppercase transition-all disabled:opacity-50"
            >
              {loading === 'monthly'
                ? '...'
                : t('planMonthly', {
                    price: new Intl.NumberFormat(locale).format(priceMonthly),
                  })}
            </button>
          </div>
        )}

        {(paymentRecovery ? portalError : error) && (
          <p className="text-fl-hint mt-4 font-mono text-red-500">
            {paymentRecovery ? portalError : error}
          </p>
        )}

        {!paymentRecovery && (
          <p className="text-fl-hint text-fl-muted-3 mt-6 font-mono tracking-widest uppercase">
            {t('paywallNoChargeTrialUsed')}
          </p>
        )}

        <button
          onClick={() => router.push('/dashboard')}
          className="text-fl-muted-4 hover:text-fl-muted-2 mt-5 w-full font-mono text-xs tracking-widest uppercase transition-colors"
        >
          {t('paywallSkip')}
        </button>
      </>
    )
  }
}
