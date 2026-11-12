'use client'

import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { TARGET_LANGUAGE_CATALOG } from '@/lib/target-languages'

interface Props {
  value: string
  onChange: (code: string) => void
  availableCodes: string[]
}

export default function TargetLanguageSelector({
  value,
  onChange,
  availableCodes,
}: Props) {
  const t = useTranslations('targetLanguages')

  const filtered = TARGET_LANGUAGE_CATALOG.filter((lang) =>
    availableCodes.includes(lang.code)
  ).sort((a, b) => t(a.code).localeCompare(t(b.code)))

  return (
    <div className="grid grid-cols-2 gap-2.5">
      {filtered.map((lang) => (
        <button
          key={lang.code}
          type="button"
          onClick={() => onChange(lang.code)}
          className={`flex items-center gap-2 rounded-xl px-3.5 py-3 text-left font-mono text-xs font-semibold tracking-widest uppercase transition-all ${
            value === lang.code
              ? 'neu-button-primary'
              : 'neu-button text-fl-fg'
          }`}
        >
          <Image
            src={lang.flagPath}
            alt={lang.code}
            width={20}
            height={16}
            className="rounded-sm object-cover"
          />
          {t(lang.code)}
        </button>
      ))}
    </div>
  )
}
