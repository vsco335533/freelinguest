'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { BookOpen } from 'lucide-react'

export default function NoPlanBanner() {
  const t = useTranslations('plan')
  const router = useRouter()

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 py-16 text-center">
      <div className="neu-glass-card w-full max-w-md rounded-3xl p-8">
        <BookOpen
          className="text-fl-accent mx-auto mb-4 h-7 w-7"
          aria-hidden="true"
        />

        <p className="text-fl-label text-fl-muted-2 mb-2 font-mono font-bold tracking-widest uppercase">
          {t('noPlanLabel')}
        </p>
        <h2 className="text-fl-fg mb-3 font-mono text-base font-bold">
          {t('noPlanTitle')}
        </h2>
        <p className="text-fl-muted-1 mb-6 font-mono text-sm leading-relaxed font-medium">
          {t('noPlanDesc')}
        </p>

        <button
          onClick={() => router.push('/assessment')}
          className="neu-button-primary w-full rounded-xl px-5 py-3.5 font-mono text-sm font-bold tracking-widest text-white uppercase"
        >
          {t('startAssessment')}
        </button>

        <p className="text-fl-hint text-fl-muted-3 mt-6 font-mono font-semibold tracking-widest uppercase">
          {t('noPlanHint')}
        </p>
      </div>
    </div>
  )
}
