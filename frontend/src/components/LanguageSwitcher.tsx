'use client'

import { useEffect, useState, useRef, useMemo } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useLanguageStore } from '@/store/language'
import { useAuthStore } from '@/store/auth'
import { getLanguageByCode } from '@/lib/target-languages'
import { trackBrowserEvent } from '@/lib/analytics'
import { apiFetch } from '@/lib/api'
import { mapUser } from '@/lib/mappers'
import {
  BASE_LOCALE_FLAGS as BASE_FLAGS,
  ORDERED_BASE_LOCALES as BASE_LANGUAGES,
  persistLocaleCookies,
} from '@/lib/locale-cookie'

export default function LanguageSwitcher() {
  const tLang = useTranslations('languages')
  const tTarget = useTranslations('targetLanguages')
  const tCommon = useTranslations('common')
  const activeLocale = useLocale()
  const router = useRouter()
  const activeLanguage = useLanguageStore((s) => s.activeLanguage)
  const userLanguages = useLanguageStore((s) => s.userLanguages)
  const isSwitching = useLanguageStore((s) => s.isSwitching)
  const needsRefresh = useLanguageStore((s) => s.needsRefresh)
  const fetchLanguages = useLanguageStore((s) => s.fetchLanguages)
  const switchLanguage = useLanguageStore((s) => s.switchLanguage)
  const sessionVersion = useAuthStore((s) => s.sessionVersion)
  const user = useAuthStore((s) => s.user)
  const setUser = useAuthStore((s) => s.setUser)

  const [open, setOpen] = useState(false)
  const [baseOpen, setBaseOpen] = useState(false)
  const [baseUpdating, setBaseUpdating] = useState(false)
  const [toast, setToast] = useState(false)
  const [toastMsg, setToastMsg] = useState('')
  const [switchFailed, setSwitchFailed] = useState(false)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(
    'loading'
  )
  const [attempt, setAttempt] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  const currentBaseCode = user?.native_language || activeLocale || 'en'
  const currentBaseName = tLang(currentBaseCode) || currentBaseCode.toUpperCase()
  const currentBaseFlag = BASE_FLAGS[currentBaseCode]

  useEffect(() => {
    const controller = new AbortController()
    setLoadState('loading')
    void fetchLanguages(controller.signal).then((ok) => {
      if (!controller.signal.aborted) setLoadState(ok ? 'ready' : 'error')
    })
    return () => controller.abort()
  }, [fetchLanguages, attempt, sessionVersion])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setBaseOpen(false)
      }
    }
    if (open || baseOpen) {
      document.addEventListener('mousedown', handleClick)
      return () => document.removeEventListener('mousedown', handleClick)
    }
  }, [open, baseOpen])

  async function handleSwitchBase(code: string) {
    if (
      (code === currentBaseCode && code === activeLocale) ||
      baseUpdating
    ) {
      setBaseOpen(false)
      return
    }
    setBaseUpdating(true)
    try {
      const res = await apiFetch('/api/auth/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ native_language: code, ui_locale: code }),
      })
      if (res.ok) {
        const data = await res.json()
        setUser(mapUser(data, user))
        persistLocaleCookies(code)
        const langName = tLang(code)
        setToastMsg(`${langName}`)
        setToast(true)
        setTimeout(() => setToast(false), 2500)
        window.location.reload()
      }
    } catch {
      // silent fail
    } finally {
      setBaseUpdating(false)
      setBaseOpen(false)
    }
  }

  async function handleSwitch(code: string) {
    setOpen(false)
    if (
      useLanguageStore.getState().isSwitching ||
      code === activeLanguage?.code
    )
      return
    setToast(false)
    setSwitchFailed(false)
    // Capture target language info before switching (store will update after)
    const targetInfo = userLanguages.find((l) => l.target_language === code)
    const ok = await switchLanguage(code)
    setSwitchFailed(!ok)
    if (ok) {
      const langName = tTarget(code)
      const level = targetInfo?.plan?.cefr_level
      setToastMsg(
        level ? tLang('switched', { language: langName, level }) : langName
      )
      setToast(true)
      setTimeout(() => setToast(false), 2500)
      router.refresh()
    }
  }

  const skeleton = useMemo(
    () => (
      <div
        role="status"
        aria-label={tCommon('loading')}
        className="flex animate-pulse items-center gap-2 px-5 py-2.5 motion-reduce:animate-none"
      >
        <div className="bg-fl-border h-3.5 w-5 rounded-xs" />
        <div className="bg-fl-border h-3 w-20 rounded" />
      </div>
    ),
    [tCommon]
  )

  if (
    (switchFailed && needsRefresh) ||
    (loadState === 'error' && (!activeLanguage || needsRefresh))
  ) {
    return (
      <div className="space-y-2 px-5 py-2.5">
        <p role="alert" className="text-fl-error-fg text-xs">
          {tCommon('errorMessage')}
        </p>
        <button
          disabled={loadState === 'loading' || isSwitching}
          onClick={() => setAttempt((value) => value + 1)}
          className="text-fl-muted-2 hover:text-fl-fg text-xs disabled:opacity-50"
        >
          {tCommon('retry')}
        </button>
      </div>
    )
  }

  if (!activeLanguage) {
    if (loadState === 'loading') return skeleton
    return (
      <Link
        href="/settings/languages"
        className="text-fl-muted-2 hover:text-fl-fg block px-5 py-2.5 text-xs"
      >
        {tLang(userLanguages.length === 0 ? 'noLanguages' : 'selectLanguage')}
      </Link>
    )
  }

  const multiple = userLanguages.length > 1

  return (
    <div ref={ref} className="relative w-full space-y-2.5 p-3">
      {toast && (
        <div className="pointer-events-none fixed inset-x-0 top-16 z-50 flex justify-center">
          <div className="glass-panel animate-fade-up text-fl-fg pointer-events-auto rounded-full px-5 py-2 font-mono text-xs tracking-widest uppercase shadow-xl motion-reduce:animate-none">
            {toastMsg}
          </div>
        </div>
      )}

      {/* Base Language Section (Fluent / Known) */}
      <div className="glass-card relative rounded-xl p-2.5">
        <div className="mb-1.5 flex items-center justify-between gap-1.5">
          <span className="text-fl-muted-3 font-mono text-[10px] font-semibold tracking-wider uppercase">
            {tLang('baseLanguageLabel')}
          </span>
          <span className="rounded-full border border-blue-500/25 bg-blue-500/12 px-2 py-0.5 font-mono text-[9px] font-semibold tracking-wider text-blue-500 uppercase">
            {tLang('fluentBadge')}
          </span>
        </div>
        <div className="relative">
          <button
            onClick={() => {
              setBaseOpen((b) => !b)
              setOpen(false)
            }}
            disabled={baseUpdating}
            className="neu-button flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-mono text-xs text-fl-fg transition-all hover:text-blue-500"
          >
            {currentBaseFlag ? (
              <Image
                src={currentBaseFlag}
                alt={currentBaseCode}
                width={18}
                height={13}
                className="border-fl-border shrink-0 rounded-xs border object-cover"
              />
            ) : (
              <span className="bg-fl-surface-2 text-fl-muted-1 border-fl-border inline-flex h-[13px] w-[18px] items-center justify-center rounded-xs border text-[9px] font-bold">
                {currentBaseCode.toUpperCase()}
              </span>
            )}
            <span className="truncate font-medium tracking-wide">
              {baseUpdating ? '...' : currentBaseName}
            </span>
            <span className="text-fl-label text-fl-muted-3 ml-auto">
              {baseOpen ? '▴' : '▾'}
            </span>
          </button>

          {baseOpen && (
            <div className="glass-panel animate-fade-up absolute top-full right-0 left-0 z-50 mt-1.5 max-h-60 overflow-y-auto rounded-xl p-1 shadow-2xl">
              {BASE_LANGUAGES.map((code) => {
                const name = tLang(code) || code.toUpperCase()
                const flag = BASE_FLAGS[code]
                const isActive = code === currentBaseCode
                return (
                  <button
                    key={code}
                    onClick={() => handleSwitchBase(code)}
                    disabled={baseUpdating}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left font-mono text-xs tracking-wide transition-colors ${
                      isActive
                        ? 'bg-blue-500/15 font-semibold text-blue-500'
                        : 'text-fl-muted-2 hover:text-fl-fg hover:bg-blue-500/8'
                    }`}
                  >
                    {flag ? (
                      <Image
                        src={flag}
                        alt={code}
                        width={18}
                        height={13}
                        className="border-fl-border shrink-0 rounded-xs border object-cover"
                      />
                    ) : (
                      <span className="bg-fl-surface-2 text-fl-muted-1 border-fl-border inline-flex h-[13px] w-[18px] items-center justify-center rounded-xs border text-[9px] font-bold">
                        {code.toUpperCase()}
                      </span>
                    )}
                    <span className="truncate">{name}</span>
                    {isActive && (
                      <span className="text-fl-label ml-auto text-blue-500">
                        ✓
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Target Language Section (Learning) */}
      <div className="glass-card relative rounded-xl p-2.5">
        <div className="mb-1.5 flex items-center justify-between gap-1.5">
          <span className="text-fl-muted-3 font-mono text-[10px] font-semibold tracking-wider uppercase">
            {tLang('targetLanguageLabel')}
          </span>
          <span className="rounded-full border border-sky-500/25 bg-sky-500/12 px-2 py-0.5 font-mono text-[9px] font-semibold tracking-wider text-sky-500 uppercase">
            {tLang('learningBadge')}
          </span>
        </div>
        <button
          onClick={() => {
            if (!multiple) return
            if (!open) trackBrowserEvent('language_selector_opened')
            setOpen((o) => !o)
            setBaseOpen(false)
          }}
          disabled={!multiple || isSwitching}
          className="neu-button text-fl-muted-1 hover:text-fl-fg flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-mono text-xs tracking-wide transition-all disabled:opacity-90"
        >
          <Image
            src={activeLanguage.flagPath}
            alt={activeLanguage.code}
            width={18}
            height={13}
            className="border-fl-border shrink-0 rounded-xs border object-cover"
          />
          <span className="text-fl-fg truncate font-medium">
            {isSwitching ? '...' : tTarget(activeLanguage.code)}
          </span>
          {multiple && (
            <span className="text-fl-label text-fl-muted-3 ml-auto">
              {open ? '▴' : '▾'}
            </span>
          )}
        </button>

        {open && multiple && (
          <div className="glass-panel animate-fade-up absolute top-full right-0 left-0 z-50 mt-1.5 max-h-56 overflow-y-auto rounded-xl p-1 shadow-2xl">
            {[...userLanguages]
              .sort((a, b) =>
                tTarget(a.target_language).localeCompare(
                  tTarget(b.target_language)
                )
              )
              .map((ulang) => {
                const lang = getLanguageByCode(ulang.target_language)
                if (!lang) return null
                return (
                  <button
                    key={ulang.target_language}
                    onClick={() => handleSwitch(ulang.target_language)}
                    disabled={isSwitching}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left font-mono text-xs tracking-wide transition-colors ${
                      ulang.is_active
                        ? 'bg-sky-500/15 font-semibold text-sky-500'
                        : 'text-fl-muted-2 hover:text-fl-fg hover:bg-sky-500/8'
                    }`}
                  >
                    <Image
                      src={lang.flagPath}
                      alt={lang.code}
                      width={18}
                      height={13}
                      className="border-fl-border shrink-0 rounded-xs border object-cover"
                    />
                    <span className="truncate">{tTarget(lang.code)}</span>
                    {ulang.plan?.cefr_level && (
                      <span className="text-fl-label ml-1 font-mono text-sky-500">
                        {ulang.plan.cefr_level}
                      </span>
                    )}
                    {ulang.is_active && (
                      <span className="text-fl-label ml-auto text-sky-500">
                        ✓
                      </span>
                    )}
                  </button>
                )
              })}
          </div>
        )}
      </div>
    </div>
  )
}
