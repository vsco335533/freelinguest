'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { Globe, Menu, X } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { LinguistLogoMark } from '@/components/ui/LinguistLogoMark'
import { apiFetch } from '@/lib/api'
import {
  BASE_LOCALE_FLAGS,
  ORDERED_BASE_LOCALES,
  persistLocaleCookies,
} from '@/lib/locale-cookie'

interface LandingNavProps {
  hasSession: boolean
  navReviews: string
  showReviews: boolean
  signIn: string
  dashboard: string
}

export function LandingNav({
  hasSession,
  navReviews,
  showReviews,
  signIn,
  dashboard,
}: LandingNavProps) {
  const tCommon = useTranslations('common')
  const tLang = useTranslations('languages')
  const activeLocale = useLocale()
  const [open, setOpen] = useState(false)
  const [langOpen, setLangOpen] = useState(false)
  const [updatingLang, setUpdatingLang] = useState(false)

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      const target = e.target as Element | null
      if (!target?.closest('[data-landing-lang]')) {
        setLangOpen(false)
      }
    }
    if (langOpen) {
      document.addEventListener('mousedown', handleOutside)
      return () => document.removeEventListener('mousedown', handleOutside)
    }
  }, [langOpen])

  async function handleSelectBaseLocale(code: string) {
    if (updatingLang) return
    setLangOpen(false)
    if (code === activeLocale) return
    setUpdatingLang(true)
    persistLocaleCookies(code)
    if (hasSession) {
      try {
        await apiFetch('/api/auth/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ native_language: code, ui_locale: code }),
        })
      } catch {
        // non-fatal: cookie already updated
      }
    }
    window.location.reload()
  }

  const currentLangName = tLang(activeLocale) || activeLocale.toUpperCase()
  const currentLangFlag = BASE_LOCALE_FLAGS[activeLocale]

  const links = (
    <>
      {showReviews && (
        <a
          href="#reviews"
          onClick={() => setOpen(false)}
          className="text-fl-muted-2 hover:text-fl-fg font-mono text-xs tracking-widest uppercase transition-colors"
        >
          {navReviews}
        </a>
      )}
      <div data-landing-lang className="relative">
        <button
          type="button"
          onClick={() => setLangOpen((prev) => !prev)}
          disabled={updatingLang}
          aria-label={tCommon('baseLanguageSelect')}
          aria-expanded={langOpen}
          className="neu-button text-fl-fg hover:text-blue-500 inline-flex items-center gap-2 rounded-lg px-3 py-1.5 font-mono text-xs font-medium tracking-wide transition-all"
        >
          {currentLangFlag ? (
            <Image
              src={currentLangFlag}
              alt={activeLocale}
              width={16}
              height={12}
              className="border-fl-border shrink-0 rounded-xs border object-cover"
            />
          ) : (
            <Globe className="size-3.5 shrink-0 text-blue-500" aria-hidden="true" />
          )}
          <span className="max-w-[96px] truncate">{currentLangName}</span>
          <span className="text-fl-muted-3 text-[10px]">{langOpen ? '▴' : '▾'}</span>
        </button>

        {langOpen && (
          <div className="glass-panel border-fl-border/70 animate-fade-up absolute right-0 z-50 mt-2 max-h-72 w-52 overflow-y-auto rounded-xl border p-1.5 shadow-2xl">
            <p className="text-fl-muted-3 px-2.5 py-1 font-mono text-[10px] font-semibold tracking-wider uppercase">
              {tCommon('baseLanguageSelect')}
            </p>
            {ORDERED_BASE_LOCALES.map((code) => {
              const name = tLang(code) || code.toUpperCase()
              const flag = BASE_LOCALE_FLAGS[code]
              const active = code === activeLocale
              return (
                <button
                  key={code}
                  type="button"
                  onClick={() => handleSelectBaseLocale(code)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-mono text-xs transition-colors ${
                    active
                      ? 'bg-blue-500/15 font-semibold text-blue-500'
                      : 'text-fl-muted-2 hover:text-fl-fg hover:bg-blue-500/8'
                  }`}
                >
                  {flag ? (
                    <Image
                      src={flag}
                      alt={code}
                      width={16}
                      height={12}
                      className="border-fl-border shrink-0 rounded-xs border object-cover"
                    />
                  ) : (
                    <span className="bg-fl-surface-2 text-fl-muted-1 border-fl-border inline-flex h-[12px] w-[16px] items-center justify-center rounded-xs border text-[8px] font-bold">
                      {code.toUpperCase()}
                    </span>
                  )}
                  <span className="truncate">{name}</span>
                  {active && <span className="ml-auto text-blue-500">✓</span>}
                </button>
              )
            })}
          </div>
        )}
      </div>
      <Link
        href={hasSession ? '/dashboard' : '/login'}
        onClick={() => setOpen(false)}
        className="neu-button text-fl-fg hover:text-blue-500 rounded-lg px-3.5 py-1.5 font-mono text-xs font-semibold tracking-widest uppercase transition-all"
      >
        {hasSession ? dashboard : signIn}
      </Link>
    </>
  )

  return (
    <nav className="glass-panel border-fl-border/60 sticky top-0 z-20 border-b">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-3">
          <LinguistLogoMark size={30} animated />
          <span className="text-fl-fg font-code text-sm font-bold tracking-widest uppercase">
            Linguist
          </span>
        </Link>

        {/* Desktop links */}
        <div className="hidden items-center gap-6 md:flex">{links}</div>

        {/* Mobile hamburger */}
        <button
          onClick={() => setOpen(!open)}
          className="neu-button text-fl-muted-2 hover:text-fl-fg rounded-lg p-1.5 md:hidden"
          aria-label={open ? tCommon('closeMenu') : tCommon('openMenu')}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {/* Mobile dropdown */}
      {open && (
        <div className="glass-panel border-fl-border/60 animate-fade-up flex flex-col gap-4 border-b px-6 py-4 md:hidden">
          {links}
        </div>
      )}
    </nav>
  )
}
