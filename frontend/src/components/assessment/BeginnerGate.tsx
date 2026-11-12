'use client'

import { useTranslations } from 'next-intl'

interface Props {
  onBeginner: () => void
  onHasExperience: () => void
  languageCode: string
}

export default function BeginnerGate({
  onBeginner,
  onHasExperience,
  languageCode,
}: Props) {
  const t = useTranslations('assessment')
  const tLang = useTranslations('targetLanguages')

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="neu-glass-card w-full max-w-md overflow-hidden rounded-3xl">
        <div className="border-fl-border/60 flex items-center gap-2 border-b px-6 py-4">
          <span className="text-fl-label text-fl-accent font-bold">●</span>
          <span className="text-fl-label text-fl-muted-2 font-mono font-bold tracking-widest uppercase">
            {t('step1')}
          </span>
        </div>
        <div className="space-y-6 p-8">
          <div className="space-y-2 text-center">
            <p className="text-fl-body text-fl-fg font-mono font-bold">
              {t('studiedBefore', { language: tLang(languageCode) })}
            </p>
            <p className="text-fl-label text-fl-muted-3 font-mono font-semibold">
              {t('studiedBeforeHint')}
            </p>
          </div>
          <div className="flex flex-col gap-3">
            <button
              onClick={onBeginner}
              className="neu-button text-fl-fg w-full rounded-2xl px-5 py-4 text-left font-mono text-sm font-semibold tracking-widest uppercase"
            >
              <span className="text-fl-muted-3 mr-3">○</span>
              {t('beginnerOption')}
              <span className="text-fl-hint text-fl-muted-2 mt-1 ml-6 block font-medium normal-case">
                {t('beginnerOptionHint')}
              </span>
            </button>
            <button
              onClick={onHasExperience}
              className="neu-button-primary w-full rounded-2xl px-5 py-4 text-left font-mono text-sm font-bold tracking-widest text-white uppercase"
            >
              <span className="mr-3">●</span>
              {t('hasExperienceOption')}
              <span className="text-fl-hint mt-1 ml-6 block font-medium text-white/90 normal-case">
                {t('hasExperienceOptionHint')}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
