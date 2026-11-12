'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useSearchParams } from 'next/navigation'
import { useConfigStore } from '@/store/config'
import { LinguistBrandHeader } from '@/components/ui/LinguistBrandHeader'

export default function PrivacyPage() {
  const t = useTranslations('legal.privacy')
  const tCommon = useTranslations('common')
  const searchParams = useSearchParams()
  const allowRegistration = useConfigStore((s) => s.allowRegistration)
  const loadConfig = useConfigStore((s) => s.load)
  const tRegister = useTranslations('auth.register')
  const invite = searchParams.get('invite')
  const inviteQuery = invite ? `&invite=${encodeURIComponent(invite)}` : ''
  const from = searchParams.get('from')
  const isFromSettings = from === 'settings'
  const isFromRegister = from === 'register'
  const isFromLanding = from === 'landing'

  useEffect(() => {
    if (isFromRegister) void loadConfig()
  }, [isFromRegister, loadConfig])
  const backHref = isFromSettings
    ? '/settings'
    : isFromRegister
      ? invite
        ? `/register?invite=${encodeURIComponent(invite)}`
        : allowRegistration
          ? '/register'
          : '/login'
      : isFromLanding
        ? '/'
        : '/'
  const backLabel = isFromSettings
    ? t('linkBackSettings')
    : isFromRegister
      ? allowRegistration || invite
        ? t('linkBack')
        : tRegister('login')
      : tCommon('back')
  const termsHref = isFromSettings
    ? '/terms?from=settings'
    : isFromRegister
      ? `/terms?from=register${inviteQuery}`
      : isFromLanding
        ? '/terms?from=landing'
        : '/terms'
  const s2Items = [
    t('s2i1'),
    t('s2i2'),
    t('s2i3'),
    t('s2i4'),
    t('s2i5'),
    t('s2i6'),
    t('s2i7'),
    t('s2i8'),
    t('s2i9'),
    t('s2i10'),
  ]
  const s3Items = [
    t('s3i1'),
    t('s3i2'),
    t('s3i3'),
    t('s3i4'),
    t('s3i5'),
    t('s3i6'),
  ]

  return (
    <div>
      <LinguistBrandHeader
        href="/"
        asHeading={false}
        size={48}
        subtitle={tCommon('tagline')}
        className="mb-10"
      />

      <div className="neu-glass-card space-y-8 p-8">
        <div className="border-fl-border/60 flex items-center gap-2 border-b pb-4">
          <span className="text-fl-label text-blue-500">●</span>
          <h1 className="text-fl-muted-2 font-mono text-xs tracking-widest uppercase">
            {t('pageTitle')}
          </h1>
        </div>

        <p className="text-fl-hint text-fl-muted-2 font-mono tracking-wide">
          {t('updated')}
        </p>

        <section className="space-y-3">
          <h2 className="text-fl-fg font-mono text-sm font-bold tracking-widest uppercase">
            {t('s1Title')}
          </h2>
          <p className="text-fl-fg-2 font-mono text-sm leading-relaxed">
            {t('s1Body')}
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-fl-fg font-mono text-sm font-bold tracking-widest uppercase">
            {t('s2Title')}
          </h2>
          <p className="text-fl-fg-2 font-mono text-sm leading-relaxed">
            {t('s2Intro')}
          </p>
          <ul className="space-y-1 pl-4">
            {s2Items.map((item) => (
              <li
                key={item}
                className="text-fl-fg-2 flex gap-2 font-mono text-sm leading-relaxed"
              >
                <span className="text-fl-muted-2 flex-shrink-0">—</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-fl-fg font-mono text-sm font-bold tracking-widest uppercase">
            {t('s3Title')}
          </h2>
          <p className="text-fl-fg-2 font-mono text-sm leading-relaxed">
            {t('s3Intro')}
          </p>
          <ul className="space-y-1 pl-4">
            {s3Items.map((item) => (
              <li
                key={item}
                className="text-fl-fg-2 flex gap-2 font-mono text-sm leading-relaxed"
              >
                <span className="text-fl-muted-2 flex-shrink-0">—</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <p className="text-fl-fg-2 font-mono text-sm leading-relaxed">
            {t('s3Footer')}
          </p>
        </section>

        {[
          { title: t('s4Title'), body: t('s4Body') },
          { title: t('s5Title'), body: t('s5Body') },
          { title: t('s6Title'), body: t('s6Body') },
          { title: t('s7Title'), body: t('s7Body') },
          { title: t('s8Title'), body: t('s8Body') },
          { title: t('s9Title'), body: t('s9Body') },
        ].map((section) => (
          <section key={section.title} className="space-y-3">
            <h2 className="text-fl-fg font-mono text-sm font-bold tracking-widest uppercase">
              {section.title}
            </h2>
            <p className="text-fl-fg-2 font-mono text-sm leading-relaxed">
              {section.body}
            </p>
          </section>
        ))}

        <div className="border-fl-border flex gap-6 border-t pt-4">
          <Link
            href={termsHref}
            className="text-fl-muted-2 hover:text-fl-fg font-mono text-xs tracking-widest uppercase transition-colors"
          >
            {t('linkTerms')}
          </Link>
          <Link
            href={backHref}
            className="text-fl-muted-2 hover:text-fl-fg font-mono text-xs tracking-widest uppercase transition-colors"
          >
            {backLabel}
          </Link>
        </div>
      </div>
    </div>
  )
}
