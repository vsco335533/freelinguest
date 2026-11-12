'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useBillingPortal } from '@/hooks/useBillingPortal'
import { useAuthStore, isSubscribed, needsPaymentRecovery } from '@/store/auth'
import { useConfigStore } from '@/store/config'
import { SubscriptionPlanButtons } from '@/components/billing/SubscriptionPlanButtons'

export function BillingSection() {
  const tBilling = useTranslations('billing')
  const locale = useLocale()
  const user = useAuthStore((s) => s.user)
  const stripeEnabled = useConfigStore((s) => s.stripeEnabled)
  const {
    openPortal,
    loading: portalLoading,
    error: portalError,
  } = useBillingPortal()
  const paymentRecovery = needsPaymentRecovery(user)
  const canManageBilling = isSubscribed(user, stripeEnabled) || paymentRecovery

  if (!stripeEnabled) return null

  return (
    <div className="glass-card rounded-2xl p-6">
      <div className="border-fl-border/60 mb-4 flex items-center gap-2 border-b pb-4">
        <span className="text-fl-accent text-fl-label">●</span>
        <span className="text-fl-label text-fl-fg font-mono font-bold tracking-widest uppercase">
          {tBilling('section')}
        </span>
      </div>
      <div className="space-y-4">
        {/* Status badge */}
        <div className="flex items-center justify-between">
          <span className="text-fl-fg font-mono text-xs font-semibold tracking-widest uppercase">
            {tBilling('status')}
          </span>
          <span
            className={`rounded-full border px-3 py-1 font-mono text-xs font-bold tracking-widest uppercase ${
              user?.subscription_status === 'active' &&
              !user?.cancel_at_period_end
                ? 'border-green-600/40 bg-green-500/10 text-green-700 dark:text-green-400'
                : user?.subscription_status === 'active' &&
                    user?.cancel_at_period_end
                  ? 'border-fl-accent/40 bg-fl-accent/10 text-fl-accent'
                  : user?.subscription_status === 'trialing'
                    ? 'border-fl-accent/40 bg-fl-accent/10 text-fl-accent'
                    : paymentRecovery
                      ? 'border-yellow-500/40 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400'
                      : 'border-fl-border text-fl-muted-2 bg-white/40 dark:bg-white/5'
            }`}
          >
            {user?.subscription_status === 'active' &&
              !user?.cancel_at_period_end &&
              tBilling('statusActive')}
            {user?.subscription_status === 'active' &&
              user?.cancel_at_period_end &&
              tBilling('statusCanceling')}
            {user?.subscription_status === 'trialing' &&
              tBilling('statusTrialing')}
            {user?.subscription_status === 'past_due' &&
              tBilling('statusPastDue')}
            {user?.subscription_status === 'unpaid' && tBilling('statusUnpaid')}
            {user?.subscription_status === 'paused' && tBilling('statusPaused')}
            {user?.subscription_status === 'incomplete' &&
              tBilling('statusIncomplete')}
            {user?.subscription_status === 'incomplete_expired' &&
              tBilling('statusIncompleteExpired')}
            {user?.subscription_status === 'canceled' &&
              tBilling('statusCanceled')}
            {(!user?.subscription_status ||
              user?.subscription_status === 'none') &&
              tBilling('statusNone')}
          </span>
        </div>

        {/* Next billing / end date */}
        {user?.subscription_ends_at &&
          (user.subscription_status === 'active' ||
            user.subscription_status === 'trialing' ||
            user.subscription_status === 'past_due' ||
            user.subscription_status === 'unpaid' ||
            user.subscription_status === 'paused' ||
            user.subscription_status === 'canceled' ||
            user.cancel_at_period_end) &&
          new Date(user.subscription_ends_at) > new Date() && (
            <div className="flex items-center justify-between">
              <span className="text-fl-muted-2 font-mono text-xs font-semibold tracking-widest uppercase">
                {user.subscription_status === 'canceled' ||
                user.cancel_at_period_end
                  ? tBilling('accessUntil')
                  : tBilling('nextBilling')}
              </span>
              <span className="text-fl-fg font-mono text-xs font-semibold">
                {new Date(user.subscription_ends_at).toLocaleDateString(locale)}
              </span>
            </div>
          )}

        {paymentRecovery && (
          <div className="glass-card rounded-xl border border-yellow-500/40 bg-yellow-500/10 p-3.5">
            <p className="font-mono text-xs font-bold tracking-widest text-yellow-700 uppercase dark:text-yellow-400">
              {tBilling('pastDueTitle')}
            </p>
            <p className="text-fl-fg mt-2 font-mono text-sm font-medium leading-relaxed">
              {tBilling('pastDueDesc')}
            </p>
          </div>
        )}

        {/* Manage or subscribe button */}
        {canManageBilling ? (
          <button
            onClick={openPortal}
            disabled={portalLoading}
            className="neu-button text-fl-fg w-full rounded-xl py-2.5 font-mono text-sm font-semibold tracking-widest uppercase transition-all disabled:opacity-50"
          >
            {portalLoading
              ? '...'
              : tBilling(paymentRecovery ? 'updatePayment' : 'manage')}
          </button>
        ) : (
          <SubscriptionPlanButtons />
        )}

        {portalError && (
          <p className="text-fl-hint font-mono text-red-500">{portalError}</p>
        )}
      </div>
    </div>
  )
}
