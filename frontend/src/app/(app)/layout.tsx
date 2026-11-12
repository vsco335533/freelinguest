'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useAuthStore, isSubscribed } from '@/store/auth'
import { useConfigStore } from '@/store/config'
import { apiFetch, requestAccessToken } from '@/lib/api'
import { isSupportedLocale, persistLocaleCookies } from '@/lib/locale-cookie'
import { mapUser } from '@/lib/mappers'
import { useLogout } from '@/hooks/useLogout'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ContactFormModal } from '@/components/ui/contact-form-modal'
import { LoadingBar } from '@/components/ui/loading-bar'
import { LinguistLogoMark } from '@/components/ui/LinguistLogoMark'
import { LinguistWelcomeLoader } from '@/components/ui/LinguistWelcomeLoader'
import {
  PageLoadingProvider,
  PageLoadingViewport,
} from '@/components/ui/page-loading-boundary'
import LanguageSwitcher from '@/components/LanguageSwitcher'
import { AuthAvatarImage } from '@/components/AuthAvatarImage'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <PageLoadingProvider>
      <AppLayoutContent>{children}</AppLayoutContent>
    </PageLoadingProvider>
  )
}

const WELCOME_LOADER_MIN_MS = 5000

function AppLayoutContent({ children }: { children: React.ReactNode }) {
  const activeLocale = useLocale()
  const tNav = useTranslations('nav')
  const tCommon = useTranslations('common')
  const pathname = usePathname()

  const mainNavItems = [
    { href: '/dashboard', label: tNav('home') },
    { href: '/plan', label: tNav('myPlan') },
    { href: '/progress', label: tNav('progress') },
    { href: '/flashcards', label: tNav('flashcards') },
    { href: '/chat', label: tNav('tutor') },
    { href: '/listening', label: tNav('listening') },
    { href: '/reading', label: tNav('reading') },
    { href: '/conversation', label: tNav('conversation') },
    { href: '/games', label: tNav('games') },
    { href: '/assessment', label: tNav('assessment') },
  ]

  const resourceNavItems = [
    { href: '/grammar', label: tNav('grammar') },
    { href: '/vocabulary', label: tNav('vocabulary') },
    { href: '/phrasebook', label: tNav('phrasebook') },
  ]

  const bottomNavItems = [
    { href: '/settings', label: tNav('settings') },
    { href: '/faq', label: tNav('faq') },
    { href: '/feedback', label: tNav('feedback') },
  ]

  const router = useRouter()
  const user = useAuthStore((s) => s.user)
  const accessToken = useAuthStore((s) => s.accessToken)
  const setTokens = useAuthStore((s) => s.setTokens)
  const setUser = useAuthStore((s) => s.setUser)
  const logout = useAuthStore((s) => s.logout)
  const handleLogout = useLogout()
  const [initializing, setInitializing] = useState(true)
  const loadConfig = useConfigStore((s) => s.load)
  const [logoutConfirm, setLogoutConfirm] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [resourcesOpen, setResourcesOpen] = useState(false)
  const [contactOpen, setContactOpen] = useState(false)
  const [resendSent, setResendSent] = useState(false)
  const [feedbackUnreadCount, setFeedbackUnreadCount] = useState(0)

  const PREMIUM_HREFS = new Set([
    '/chat',
    '/listening',
    '/reading',
    '/conversation',
  ])
  const stripeEnabled = useConfigStore((s) => s.stripeEnabled)
  const showPremiumBadge = stripeEnabled && !isSubscribed(user, stripeEnabled)

  async function handleResendVerification() {
    const res = await apiFetch('/api/auth/resend-verification', {
      method: 'POST',
    })
    if (res.ok) setResendSent(true)
  }

  // On every page load, Zustand is empty. Use the httpOnly refresh cookie
  // to silently get a new access token, then fetch /me to populate the user.
  useEffect(() => {
    let canceled = false
    let stayLoading = false
    let timerId: number | undefined
    const controller = new AbortController()
    const startedAt = Date.now()
    const { sessionVersion } = useAuthStore.getState()
    const obsolete = () =>
      canceled || useAuthStore.getState().sessionVersion !== sessionVersion
    async function init() {
      // Load Stripe config once (non-blocking)
      loadConfig()
      try {
        if (!accessToken) {
          const access_token = await requestAccessToken()
          if (obsolete()) return
          setTokens(access_token)
        }
        // Fetch user info if not already loaded
        const meRes = await apiFetch('/api/auth/me', {
          signal: controller.signal,
        })
        if (obsolete()) return
        if (!meRes.ok) {
          stayLoading = true
          logout()
          router.push('/login')
          return
        }
        const me = await meRes.json()
        if (obsolete()) return
        setUser(mapUser(me))

        const preferredLocale = me.ui_locale || me.native_language
        if (isSupportedLocale(preferredLocale) && preferredLocale !== activeLocale) {
          stayLoading = true
          persistLocaleCookies(preferredLocale)
          window.location.reload()
          return
        }

        if (me.learning_goals === null) {
          stayLoading = true
          router.replace('/onboarding')
          return
        }

        const remaining = WELCOME_LOADER_MIN_MS - (Date.now() - startedAt)
        if (remaining > 0) {
          await new Promise<void>((resolve) => {
            timerId = window.setTimeout(resolve, remaining)
          })
          if (obsolete()) return
        }
      } catch {
        if (obsolete()) return
        stayLoading = true
        logout()
        router.push('/login')
      } finally {
        if (!canceled && !stayLoading) setInitializing(false)
      }
    }
    init()
    return () => {
      canceled = true
      if (timerId !== undefined) window.clearTimeout(timerId)
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (initializing) return

    async function loadFeedbackUnreadCount() {
      try {
        const res = await apiFetch('/api/feedback/unread-summary')
        if (!res.ok) return
        const data = await res.json()
        setFeedbackUnreadCount(data.unread_count ?? 0)
      } catch {
        setFeedbackUnreadCount(0)
      }
    }

    loadFeedbackUnreadCount()
    window.addEventListener('freelingo:feedback-read', loadFeedbackUnreadCount)
    return () => {
      window.removeEventListener(
        'freelingo:feedback-read',
        loadFeedbackUnreadCount
      )
    }
  }, [initializing])

  if (initializing) {
    return (
      <PageLoadingViewport className="h-dvh">
        <LinguistWelcomeLoader
          label={tCommon('initializing')}
          minDurationMs={WELCOME_LOADER_MIN_MS}
          fullScreen
        />
      </PageLoadingViewport>
    )
  }

  const feedbackBadgeText =
    feedbackUnreadCount > 99
      ? '99+'
      : feedbackUnreadCount > 0
        ? String(feedbackUnreadCount)
        : ''

  return (
    <div className="fl-gradient-bg flex h-dvh overflow-hidden">
      {/* Sidebar */}
      <aside className="glass-panel border-fl-border/70 hidden w-64 shrink-0 flex-col border-r px-0 py-0 md:flex">
        {/* Logo area */}
        <div className="border-fl-border/60 flex items-center gap-3 border-b px-5 py-4">
          <LinguistLogoMark size={30} animated />
          <div className="flex flex-col">
            <span className="text-fl-fg font-code text-sm font-bold tracking-widest uppercase">
              Linguist
            </span>
            <span className="text-fl-muted-3 font-mono text-[9px] tracking-widest uppercase">
              {tCommon('aiTutor')}
            </span>
          </div>
        </div>

        {/* Language switcher */}
        <div className="border-fl-border/60 border-b">
          <LanguageSwitcher />
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1 overflow-y-auto px-2.5 py-4">
          {/* Main items */}
          {mainNavItems.map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(item.href + '/')
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`glass-nav-item flex items-center gap-3 px-3.5 py-2.5 font-mono text-xs tracking-wide wrap-anywhere transition-all ${active
                    ? 'border border-blue-500/30 bg-blue-500/12 font-semibold text-blue-500 shadow-[0_4px_14px_rgba(37,99,235,0.12)]'
                    : 'text-fl-muted-2 hover:text-fl-fg hover:bg-blue-500/8 border border-transparent'
                  }`}
              >
                <span
                  className={`text-fl-label ${active ? 'text-blue-500' : 'text-fl-muted-4'}`}
                >
                  ●
                </span>
                {item.label}
                {showPremiumBadge && PREMIUM_HREFS.has(item.href) && (
                  <span className="text-fl-accent ml-auto text-xs">★</span>
                )}
              </Link>
            )
          })}

          {/* Resources group */}
          <div className="mt-2 pt-2">
            <button
              onClick={() => setResourcesOpen((o) => !o)}
              className="glass-nav-item text-fl-muted-4 hover:text-fl-muted-2 flex w-full items-center justify-between px-3.5 py-2 font-mono text-xs tracking-wide wrap-anywhere uppercase transition-colors"
            >
              <span>{tNav('resources')}</span>
              <span className="text-fl-label">{resourcesOpen ? '▴' : '▾'}</span>
            </button>
            {resourcesOpen &&
              resourceNavItems.map((item) => {
                const active =
                  pathname === item.href || pathname.startsWith(item.href + '/')
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`glass-nav-item flex items-center gap-3 py-2 pr-3.5 pl-6 font-mono text-xs tracking-wide wrap-anywhere transition-all ${active
                        ? 'border border-blue-500/30 bg-blue-500/12 font-semibold text-blue-500 shadow-[0_4px_12px_rgba(37,99,235,0.1)]'
                        : 'text-fl-muted-2 hover:text-fl-fg hover:bg-blue-500/8 border border-transparent'
                      }`}
                  >
                    <span
                      className={`text-fl-label ${active ? 'text-blue-500' : 'text-fl-muted-4'}`}
                    >
                      ·
                    </span>
                    {item.label}
                  </Link>
                )
              })}
          </div>

          {/* Bottom items */}
          <div className="border-fl-border/60 mt-2 space-y-1 border-t pt-3">
            {bottomNavItems.map((item) => {
              const active =
                pathname === item.href || pathname.startsWith(item.href + '/')
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`glass-nav-item flex items-center gap-3 px-3.5 py-2.5 font-mono text-xs tracking-wide wrap-anywhere transition-all ${active
                      ? 'border border-blue-500/30 bg-blue-500/12 font-semibold text-blue-500 shadow-[0_4px_14px_rgba(37,99,235,0.12)]'
                      : 'text-fl-muted-2 hover:text-fl-fg hover:bg-blue-500/8 border border-transparent'
                    }`}
                >
                  <span
                    className={`text-fl-label ${active ? 'text-blue-500' : 'text-fl-muted-4'}`}
                  >
                    ●
                  </span>
                  {item.label}
                  {item.href === '/feedback' && feedbackBadgeText && (
                    <span className="text-fl-label ml-auto flex h-6 w-6 shrink-0 -translate-y-0.5 items-center justify-center rounded-full bg-red-600 leading-none font-bold tracking-normal text-white">
                      {feedbackBadgeText}
                    </span>
                  )}
                </Link>
              )
            })}
          </div>

          {user?.role === 'admin' && (
            <Link
              href="/admin"
              className={`glass-nav-item flex items-center gap-3 px-3.5 py-2.5 font-mono text-xs tracking-wide wrap-anywhere transition-all ${pathname.startsWith('/admin')
                  ? 'border border-blue-500/30 bg-blue-500/12 font-semibold text-blue-500 shadow-[0_4px_14px_rgba(37,99,235,0.12)]'
                  : 'text-fl-muted-2 hover:text-fl-fg hover:bg-blue-500/8 border border-transparent'
                }`}
            >
              <span className="text-fl-label text-fl-muted-4">●</span>
              {tNav('admin')}
            </Link>
          )}
        </nav>

        {/* User + logout */}
        <div className="border-fl-border border-t px-5 py-4">
          <div className="mb-3 flex items-center gap-3">
            <div className="border-fl-border h-8 w-8 flex-shrink-0 overflow-hidden rounded-full border">
              {user?.avatar ? (
                <AuthAvatarImage
                  avatar={user.avatar}
                  alt=""
                  width={32}
                  height={32}
                  className="h-full w-full object-cover"
                  fallback={
                    <div className="bg-fl-surface-2 flex h-full w-full items-center justify-center">
                      <span className="text-fl-muted-1 font-mono text-xs select-none">
                        {(user?.displayName ||
                          user?.username ||
                          '?')[0].toUpperCase()}
                      </span>
                    </div>
                  }
                />
              ) : (
                <div className="bg-fl-surface-2 flex h-full w-full items-center justify-center">
                  <span className="text-fl-muted-1 font-mono text-xs select-none">
                    {(user?.displayName ||
                      user?.username ||
                      '?')[0].toUpperCase()}
                  </span>
                </div>
              )}
            </div>
            <div className="min-w-0">
              <p className="text-fl-caption text-fl-muted-2 truncate font-mono tracking-widest uppercase">
                {user?.displayName || user?.username}
              </p>
              <p className="text-fl-label text-fl-muted-4 truncate font-mono">
                @{user?.username?.toLowerCase()}
              </p>
            </div>
          </div>
          <p className="text-fl-label text-fl-muted-4 font-code mb-2 tracking-wider">
            v1.01
          </p>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => setContactOpen(true)}
              className="neu-button text-fl-muted-2 hover:text-fl-fg w-full rounded-lg px-3 py-1.5 text-left font-mono text-xs tracking-widest uppercase transition-all"
            >
              {tNav('contact')}
            </button>
            <button
              onClick={() => setLogoutConfirm(true)}
              className="neu-button text-fl-muted-2 hover:text-fl-fg w-full rounded-lg px-3 py-1.5 text-left font-mono text-xs tracking-widest uppercase transition-all"
            >
              {tCommon('logout')}
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="glass-panel border-fl-border/70 fixed top-0 right-0 left-0 z-50 border-b md:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2.5">
            <LinguistLogoMark size={24} animated />
            <span className="text-fl-fg font-code text-xs font-bold tracking-widest uppercase">
              Linguist
            </span>
          </div>
          <button
            onClick={() => setMobileMenuOpen((o) => !o)}
            className="neu-button text-fl-muted-2 hover:text-fl-fg rounded-lg px-2.5 py-1 font-mono transition-all"
            aria-label={
              mobileMenuOpen ? tCommon('closeMenu') : tCommon('openMenu')
            }
          >
            <span className="text-base leading-none">
              {mobileMenuOpen ? '✕' : '☰'}
            </span>
          </button>
        </div>

        {/* Dropdown */}
        {mobileMenuOpen && (
          <nav className="glass-panel border-fl-border/60 animate-fade-up max-h-[calc(100svh-3.5rem)] space-y-1 overflow-y-auto overscroll-contain border-t px-2.5 pb-3">
            <div className="border-fl-border/60 border-b">
              <LanguageSwitcher />
            </div>
            {mainNavItems.map((item) => {
              const active =
                pathname === item.href || pathname.startsWith(item.href + '/')
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`glass-nav-item flex items-center gap-3 px-3.5 py-2.5 font-mono text-xs tracking-wide wrap-anywhere uppercase transition-all ${active
                      ? 'border border-blue-500/30 bg-blue-500/12 font-semibold text-blue-500'
                      : 'text-fl-muted-2 hover:text-fl-fg hover:bg-blue-500/8 border border-transparent'
                    }`}
                >
                  <span
                    className={`text-fl-label ${active ? 'text-fl-fg' : 'text-fl-muted-4'}`}
                  >
                    ●
                  </span>
                  {item.label}
                  {showPremiumBadge && PREMIUM_HREFS.has(item.href) && (
                    <span className="text-fl-accent ml-auto text-xs">★</span>
                  )}
                </Link>
              )
            })}

            {/* Resources group (mobile) */}
            <div>
              <button
                onClick={() => setResourcesOpen((o) => !o)}
                className="text-fl-muted-4 hover:text-fl-muted-2 flex w-full items-center justify-between border-l-2 border-transparent px-5 py-2 font-mono text-sm tracking-wide wrap-anywhere uppercase transition-colors"
              >
                <span>{tNav('resources')}</span>
                <span className="text-fl-label">
                  {resourcesOpen ? '▴' : '▾'}
                </span>
              </button>
              {resourcesOpen &&
                resourceNavItems.map((item) => {
                  const active =
                    pathname === item.href ||
                    pathname.startsWith(item.href + '/')
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setMobileMenuOpen(false)}
                      className={`glass-nav-item flex items-center gap-3 py-2 pr-3.5 pl-6 font-mono text-xs tracking-wide wrap-anywhere uppercase transition-all ${active
                          ? 'border border-blue-500/30 bg-blue-500/12 font-semibold text-blue-500'
                          : 'text-fl-muted-2 hover:text-fl-fg hover:bg-blue-500/8 border border-transparent'
                        }`}
                    >
                      <span
                        className={`text-fl-label ${active ? 'text-blue-500' : 'text-fl-muted-4'}`}
                      >
                        ·
                      </span>
                      {item.label}
                    </Link>
                  )
                })}
            </div>

            {/* Bottom items (mobile) */}
            {bottomNavItems.map((item) => {
              const active =
                pathname === item.href || pathname.startsWith(item.href + '/')
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`glass-nav-item flex items-center gap-3 px-3.5 py-2.5 font-mono text-xs tracking-wide wrap-anywhere uppercase transition-all ${active
                      ? 'border border-blue-500/30 bg-blue-500/12 font-semibold text-blue-500'
                      : 'text-fl-muted-2 hover:text-fl-fg hover:bg-blue-500/8 border border-transparent'
                    }`}
                >
                  <span
                    className={`text-fl-label ${active ? 'text-blue-500' : 'text-fl-muted-4'}`}
                  >
                    ●
                  </span>
                  {item.label}
                  {item.href === '/feedback' && feedbackBadgeText && (
                    <span className="text-fl-label ml-auto flex h-6 w-6 shrink-0 -translate-y-0.5 items-center justify-center rounded-full bg-red-600 leading-none font-bold tracking-normal text-white">
                      {feedbackBadgeText}
                    </span>
                  )}
                </Link>
              )
            })}

            {user?.role === 'admin' && (
              <Link
                href="/admin"
                onClick={() => setMobileMenuOpen(false)}
                className={`glass-nav-item flex items-center gap-3 px-3.5 py-2.5 font-mono text-xs tracking-wide wrap-anywhere uppercase transition-all ${pathname.startsWith('/admin')
                    ? 'border border-blue-500/30 bg-blue-500/12 font-semibold text-blue-500'
                    : 'text-fl-muted-2 hover:text-fl-fg hover:bg-blue-500/8 border border-transparent'
                  }`}
              >
                <span className="text-fl-label text-fl-muted-4">●</span>
                {tNav('admin')}
              </Link>
            )}
            <div className="border-fl-border mx-5 mt-2 border-t pt-3">
              <div className="mb-2 flex items-center gap-3">
                <div className="border-fl-border h-7 w-7 flex-shrink-0 overflow-hidden rounded-full border">
                  {user?.avatar ? (
                    <AuthAvatarImage
                      avatar={user.avatar}
                      alt=""
                      width={28}
                      height={28}
                      className="h-full w-full object-cover"
                      fallback={
                        <div className="bg-fl-surface-2 flex h-full w-full items-center justify-center">
                          <span className="text-fl-hint text-fl-muted-1 font-mono select-none">
                            {(user?.displayName ||
                              user?.username ||
                              '?')[0].toUpperCase()}
                          </span>
                        </div>
                      }
                    />
                  ) : (
                    <div className="bg-fl-surface-2 flex h-full w-full items-center justify-center">
                      <span className="text-fl-hint text-fl-muted-1 font-mono select-none">
                        {(user?.displayName ||
                          user?.username ||
                          '?')[0].toUpperCase()}
                      </span>
                    </div>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-fl-caption text-fl-muted-2 truncate font-mono tracking-widest uppercase">
                    {user?.displayName || user?.username}
                  </p>
                  <p className="text-fl-label text-fl-muted-4 truncate font-mono">
                    @{user?.username?.toLowerCase()}
                  </p>
                </div>
              </div>
              <p className="text-fl-label text-fl-muted-4 font-code mb-2 tracking-wider">
                v1.01
              </p>
              <button
                onClick={() => {
                  setMobileMenuOpen(false)
                  setContactOpen(true)
                }}
                className="text-fl-muted-2 hover:text-fl-fg mb-1 block font-mono text-xs tracking-widest uppercase transition-colors"
              >
                {tNav('contact')}
              </button>
              <button
                onClick={() => {
                  setMobileMenuOpen(false)
                  setLogoutConfirm(true)
                }}
                className="text-fl-muted-2 hover:text-fl-fg font-mono text-xs tracking-widest uppercase transition-colors"
              >
                {tCommon('logout')}
              </button>
            </div>
          </nav>
        )}
      </div>

      {/* Main */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pt-14 md:pt-0">
        {/* Email verification banner */}
        {user && user.is_verified === false && (
          <div className="border-fl-border bg-fl-surface flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2">
            <span className="text-fl-muted-1 font-mono text-xs tracking-wide">
              ● {tCommon('verifyEmailBanner')}
            </span>
            {resendSent ? (
              <span className="text-fl-muted-2 font-mono text-xs">
                {tCommon('verifyEmailSent')}
              </span>
            ) : (
              <button
                onClick={handleResendVerification}
                className="text-fl-accent font-mono text-xs underline transition-all hover:no-underline"
              >
                {tCommon('resendVerification')}
              </button>
            )}
          </div>
        )}
        <PageLoadingViewport>{children}</PageLoadingViewport>
      </main>

      <LoadingBar />

      <ContactFormModal
        open={contactOpen}
        onClose={() => setContactOpen(false)}
      />

      <ConfirmDialog
        open={logoutConfirm}
        title={tCommon('logoutConfirmTitle')}
        message={tCommon('logoutConfirmMessage')}
        confirmLabel={tCommon('logout')}
        onConfirm={handleLogout}
        onCancel={() => setLogoutConfirm(false)}
      />
    </div>
  )
}
