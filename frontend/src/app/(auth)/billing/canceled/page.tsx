'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
  AuthBackdropOrbs,
  LinguistBrandHeader,
} from '@/components/ui/LinguistBrandHeader'

export default function BillingCanceledPage() {
  const t = useTranslations('billing')

  return (
    <div className="fl-gradient-bg relative flex min-h-screen items-center justify-center px-4 py-10">
      <AuthBackdropOrbs />
      <div className="relative z-10 w-full max-w-sm">
        <LinguistBrandHeader size={48} className="mb-8" />
        <div className="neu-glass-card w-full space-y-5 p-8 text-center">
          <div className="text-fl-muted-2 text-2xl">△</div>
          <p className="text-fl-label text-fl-muted-2 font-mono tracking-widest uppercase">
            {t('canceledLabel')}
          </p>
          <h2 className="text-fl-fg font-mono text-base font-bold">
            {t('canceledTitle')}
          </h2>
          <p className="text-fl-muted-1 font-mono text-xs leading-relaxed">
            {t('canceledDesc')}
          </p>
          <div className="flex flex-col gap-2.5">
            <Link
              href="/dashboard"
              className="neu-button-primary block py-3 font-mono text-sm font-bold tracking-widest uppercase"
            >
              {t('canceledCtaDashboard')}
            </Link>
            <Link
              href="/settings"
              className="neu-button text-fl-muted-1 hover:text-fl-fg block py-3 font-mono text-xs tracking-widest uppercase"
            >
              {t('canceledCtaSettings')}
            </Link>
          </div>
          <p className="text-fl-hint text-fl-muted-3 font-mono tracking-widest uppercase">
            {t('canceledNoCharge')}
          </p>
        </div>
      </div>
    </div>
  )
}
