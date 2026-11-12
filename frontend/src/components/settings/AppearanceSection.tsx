'use client'

import { useTranslations } from 'next-intl'
import { useThemeStore } from '@/store/theme'
import { trackBrowserEvent } from '@/lib/analytics'

export function AppearanceSection({ title }: { title?: string } = {}) {
  const t = useTranslations('settings')
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)

  return (
    <div className="glass-card rounded-2xl p-6">
      <div className="border-fl-border/60 mb-5 flex items-center gap-2 border-b pb-4">
        <span className="text-fl-accent text-fl-label">●</span>
        <span className="text-fl-label text-fl-fg font-mono font-bold tracking-widest uppercase">
          {title ?? t('sectionAppearance')}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-fl-fg font-mono text-xs font-semibold tracking-wide">
            {t('theme')}
          </p>
          <p className="text-fl-label text-fl-muted-2 mt-0.5 font-mono font-medium">
            {theme === 'dark'
              ? t('darkActive')
              : theme === 'light'
                ? t('lightActive')
                : t('systemActive')}
          </p>
        </div>
        <div className="flex gap-2">
          {(['system', 'dark', 'light'] as const).map((opt) => (
            <button
              key={opt}
              onClick={() => {
                if (theme !== opt) trackBrowserEvent('appearance_changed')
                setTheme(opt)
              }}
              className={`rounded-xl px-4 py-2 font-mono text-xs font-semibold tracking-widest uppercase transition-all ${theme === opt
                  ? 'neu-button-primary'
                  : 'neu-button text-fl-muted-2 hover:text-fl-fg'
                }`}
            >
              {opt === 'system'
                ? t('themeSystem')
                : opt === 'dark'
                  ? t('themeDark')
                  : t('themeLight')}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
