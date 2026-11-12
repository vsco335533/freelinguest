'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

interface Props {
  planId: number
  level: string
}

export default function LevelTestBanner({ planId, level }: Props) {
  const t = useTranslations('plan')
  const router = useRouter()

  return (
    <div className="neu-card mt-2 overflow-hidden rounded-2xl">
      <div className="border-fl-border/60 flex items-center gap-2 border-b px-6 py-4">
        <span className="text-fl-label text-fl-accent font-mono font-bold">
          ⊞
        </span>
        <span className="text-fl-label text-fl-fg font-mono font-bold tracking-widest uppercase">
          {t('levelComplete', { level })}
        </span>
      </div>
      <div className="space-y-4 p-6">
        <p className="text-fl-label text-fl-muted-1 font-mono leading-relaxed font-medium">
          {t('levelCompleteDesc', { level })}
        </p>
        <p className="text-fl-hint text-fl-muted-3 font-mono font-semibold">
          {t('levelCompleteHint')}
        </p>
        <button
          onClick={() => router.push(`/assessment/level-test?plan=${planId}`)}
          className="neu-button-primary rounded-xl px-6 py-3 font-mono text-sm font-bold tracking-widest text-white uppercase"
        >
          {t('beginLevelTest')} →
        </button>
      </div>
    </div>
  )
}
