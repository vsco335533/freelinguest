import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { LinguistLogoMark } from '@/components/ui/LinguistLogoMark'
import { AuthBackdropOrbs } from '@/components/ui/LinguistBrandHeader'

export default async function NotFound() {
  const t = await getTranslations('notFound')

  return (
    <div className="fl-gradient-bg relative flex min-h-screen items-center justify-center p-6">
      <AuthBackdropOrbs />
      <div className="neu-glass-card relative z-10 w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="border-fl-border/60 flex items-center gap-3 border-b px-8 py-5">
          <LinguistLogoMark size={26} />
          <span className="text-fl-fg font-code text-xs font-bold tracking-widest uppercase">
            Linguist
          </span>
        </div>

        {/* Body */}
        <div className="space-y-6 px-8 py-8">
          <div className="space-y-1">
            <p className="text-fl-label font-mono tracking-widest text-blue-500 uppercase">
              404
            </p>
            <h1 className="text-fl-fg font-mono text-xl font-bold tracking-tight">
              {t('title')}
            </h1>
          </div>

          <p className="text-fl-fg-2 font-mono text-sm leading-relaxed">
            {t('body')}
          </p>

          <div className="flex flex-col gap-3 pt-2 sm:flex-row">
            <Link
              href="/dashboard"
              className="neu-button-primary flex-1 px-6 py-3 text-center font-mono text-sm font-bold tracking-widest uppercase"
            >
              {t('dashboard')}
            </Link>
            <Link
              href="/"
              className="neu-button text-fl-fg-2 flex-1 px-6 py-3 text-center font-mono text-xs tracking-widest uppercase"
            >
              {t('home')}
            </Link>
          </div>
        </div>

        {/* Footer */}
        <div className="border-fl-border/60 border-t px-8 py-4">
          <p className="text-fl-hint text-fl-muted-2 text-center font-mono">
            &copy; Linguist
          </p>
        </div>
      </div>
    </div>
  )
}
