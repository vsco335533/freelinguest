import Link from 'next/link'
import { cookies } from 'next/headers'
import { getLocale, getTranslations } from 'next-intl/server'
import type { Metadata } from 'next'
import { ArrowRight } from 'lucide-react'
import { LandingNav } from '@/components/ui/landing-nav'
import { ScrollReveal } from '@/components/ui/scroll-reveal'
import { ContactButton } from '@/components/ui/contact-button'
import { LanguageBubbles } from '@/components/LanguageBubbles'
import { LandingReviewsCarousel } from '@/components/reviews/LandingReviewsCarousel'
import type { ReviewPublic, ReviewPublicSummary } from '@/types/api'
import { createPublicMetadata, SITE_URL } from '@/lib/seo'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('landing')
  return createPublicMetadata({
    path: '/',
    title: t('seoTitle'),
    description: t('seoDescription'),
    locale: await getLocale(),
  })
}

const jsonLd = {
  '@type': 'WebApplication',
  '@id': `${SITE_URL}/#application`,
  name: 'Linguist',
  applicationCategory: 'EducationalApplication',
  operatingSystem: 'Any',
  browserRequirements: 'Requires a modern web browser with JavaScript enabled.',
  url: `${SITE_URL}/`,
  author: {
    '@type': 'Person',
    name: 'Arturo Carretero Calvo',
    url: 'https://www.arturocarreterocalvo.com',
  },
}

export default async function Home() {
  const cookieStore = await cookies()
  const hasSession = cookieStore.has('refresh_token')
  const t = await getTranslations('landing')
  const tCommon = await getTranslations('common')
  const locale = await getLocale()

  let allowRegistration = false
  let stripeEnabled = false
  let reviews: ReviewPublic[] = []
  let reviewSummary: ReviewPublicSummary | null = null
  try {
    const backendUrl = process.env.BACKEND_URL || 'http://backend:8000'
    const [configRes, publicReviews, publicReviewSummary] = await Promise.all([
      // Landing CTAs can lag registration changes by the existing one-hour cache.
      // The backend still enforces ALLOW_REGISTRATION on every signup request.
      fetch(`${backendUrl}/api/config`, {
        next: { revalidate: 3600 },
      }).catch(() => null),
      fetch(`${backendUrl}/api/reviews/public?limit=50`, {
        next: { revalidate: 300 },
      })
        .then((res) => (res.ok ? res.json() : []))
        .catch(() => []),
      fetch(`${backendUrl}/api/reviews/public/summary`, {
        next: { revalidate: 300 },
      })
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
    ])
    reviews = publicReviews
    reviewSummary = publicReviewSummary
    if (configRes?.ok) {
      const cfg = await configRes.json()
      allowRegistration = cfg.allow_registration === true
      stripeEnabled = cfg.stripe_enabled ?? false
    }
  } catch {
    /* non-fatal */
  }

  const startHref = hasSession
    ? '/dashboard'
    : allowRegistration
      ? '/register'
      : '/login'
  const startLabel = hasSession
    ? t('dashboard')
    : allowRegistration
      ? t('startFree')
      : t('signIn')
  const showFreeNote = !hasSession && allowRegistration && stripeEnabled
  const startClassName =
    'neu-button-primary inline-flex items-center justify-center gap-3 rounded-xl px-7 py-3.5 text-center font-sans text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-500'

  return (
    <div className="fl-gradient-bg text-fl-fg relative flex min-h-screen flex-col overflow-x-clip">
      <div
        className="pointer-events-none fixed inset-0 overflow-hidden"
        aria-hidden="true"
      >
        <div className="absolute -top-28 -left-24 h-96 w-96 rounded-full bg-sky-400/25 blur-3xl dark:bg-sky-500/15" />
        <div className="absolute top-1/4 -right-28 h-[28rem] w-[28rem] rounded-full bg-blue-500/20 blur-3xl dark:bg-blue-600/20" />
        <div className="absolute -bottom-32 left-1/3 h-80 w-80 rounded-full bg-white/70 blur-3xl dark:bg-indigo-500/10" />
      </div>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@graph': [
              {
                '@type': 'WebSite',
                '@id': `${SITE_URL}/#website`,
                name: 'Linguist',
                url: `${SITE_URL}/`,
                inLanguage: locale,
                about: { '@id': jsonLd['@id'] },
              },
              {
                ...jsonLd,
                description: t('seoDescription'),
                inLanguage: locale,
                // Describe only the free signup actually offered on this response.
                ...(allowRegistration && !hasSession
                  ? {
                      offers: {
                        '@type': 'Offer',
                        name: t('startFree'),
                        price: 0,
                        url: `${SITE_URL}/register`,
                      },
                    }
                  : {}),
              },
            ],
          }).replace(/</g, '\\u003c'),
        }}
      />

      {/* Nav */}
      <LandingNav
        hasSession={hasSession}
        navReviews={t('navReviews')}
        showReviews={reviews.length > 0 || (reviewSummary?.total ?? 0) > 0}
        signIn={t('signIn')}
        dashboard={t('dashboard')}
      />

      <main className="contents">
        {/* Hero */}
        <section className="flex flex-1 flex-col items-center justify-center px-6 pt-[10px] pb-12 text-center">
          <div className="mb-1 flex w-full flex-col items-center">
            <div className="mb-0 w-full max-w-[560px]">
              <LanguageBubbles />
            </div>
            <span className="text-fl-label text-fl-muted-2 mb-4 font-mono tracking-widest uppercase">
              {tCommon('tagline')}
            </span>
            <h1 className="text-fl-fg mb-4 max-w-2xl font-sans text-3xl leading-tight font-bold tracking-tight text-balance md:text-5xl">
              {t('hero')}
            </h1>
            <p className="text-fl-muted-1 mb-8 max-w-xl font-sans text-base leading-relaxed md:text-lg">
              {t('heroSub')}
            </p>
          </div>
          <div className="flex flex-col items-center gap-3 sm:flex-row">
            <Link href={startHref} className={startClassName}>
              {startLabel}
              <ArrowRight className="size-4 shrink-0" aria-hidden="true" />
            </Link>
          </div>
          {showFreeNote && (
            <p className="text-fl-muted-1 mt-4 max-w-lg font-sans text-sm leading-relaxed">
              {t('freeNote')}
            </p>
          )}
        </section>

        {/* Reviews */}
        <ScrollReveal>
          <LandingReviewsCarousel reviews={reviews} summary={reviewSummary} />
        </ScrollReveal>
      </main>

      {/* Footer */}
      <footer className="glass-panel border-fl-border/60 relative z-10 border-t px-6 py-10">
        <div className="mx-auto grid max-w-4xl grid-cols-2 gap-8 md:grid-cols-4">
          <div>
            <span className="text-fl-hint text-fl-muted-3 font-code block tracking-widest uppercase">
              Linguist
            </span>
            <span className="text-fl-hint text-fl-muted-4 mt-2 block font-mono leading-relaxed">
              © {new Date().getFullYear()}
            </span>
          </div>
          <div>
            <h2 className="text-fl-label text-fl-muted-2 mb-3 font-sans text-sm font-semibold tracking-tight">
              {t('footerProduct')}
            </h2>
            <div className="flex flex-col gap-2">
              <a
                href="https://github.com/artcc/freelingo"
                target="_blank"
                rel="noopener noreferrer"
                className="text-fl-hint text-fl-muted-3 hover:text-fl-muted-1 font-mono tracking-widest uppercase transition-colors"
              >
                {t('github')}
              </a>
            </div>
          </div>
          <div>
            <h2 className="text-fl-label text-fl-muted-2 mb-3 font-sans text-sm font-semibold tracking-tight">
              {t('footerLegal')}
            </h2>
            <div className="flex flex-col gap-2">
              <Link
                href="/privacy?from=landing"
                className="text-fl-hint text-fl-muted-3 hover:text-fl-muted-1 font-mono tracking-widest uppercase transition-colors"
              >
                {t('privacy')}
              </Link>
              <Link
                href="/terms?from=landing"
                className="text-fl-hint text-fl-muted-3 hover:text-fl-muted-1 font-mono tracking-widest uppercase transition-colors"
              >
                {t('terms')}
              </Link>
            </div>
          </div>
          <div>
            <h2 className="text-fl-label text-fl-muted-2 mb-3 font-sans text-sm font-semibold tracking-tight">
              {t('contact')}
            </h2>
            <div className="flex flex-col gap-2">
              <a
                href="https://www.arturocarreterocalvo.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-fl-hint text-fl-muted-3 hover:text-fl-muted-1 font-mono tracking-widest uppercase transition-colors"
              >
                {t('aboutMe')}
              </a>
              <ContactButton />
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}
