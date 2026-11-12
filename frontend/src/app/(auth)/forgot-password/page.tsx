'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import {
  AuthBackdropOrbs,
  LinguistBrandHeader,
} from '@/components/ui/LinguistBrandHeader'

export default function ForgotPasswordPage() {
  const t = useTranslations('auth.forgotPassword')
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await apiFetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      if (!res.ok) throw new Error(t('error'))
      setSent(true)
    } catch {
      setError(t('error'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fl-gradient-bg relative flex min-h-screen items-center justify-center px-4 py-10">
      <AuthBackdropOrbs />
      <div className="relative z-10 w-full max-w-sm">
        <LinguistBrandHeader />

        <div className="neu-glass-card animate-fade-up space-y-6 p-8">
          <div className="border-fl-border/60 flex items-center gap-2 border-b pb-4">
            <span className="text-fl-label text-blue-500">●</span>
            <span className="text-fl-caption text-fl-muted-2 font-mono tracking-widest uppercase">
              {t('title')}
            </span>
          </div>

          {sent ? (
            <div className="space-y-4">
              <p className="text-fl-muted-1 font-mono text-sm leading-relaxed">
                {t('sent')}
              </p>
              <Link
                href="/login"
                className="text-fl-muted-2 hover:text-fl-fg block font-mono text-xs underline transition-colors"
              >
                {t('backToLogin')}
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <p className="text-fl-muted-2 font-mono text-sm leading-relaxed">
                {t('description')}
              </p>
              {error && (
                <div className="border-fl-error/40 bg-fl-error/5 text-fl-error rounded-xl border px-4 py-3 font-mono text-xs">
                  ✕ {error}
                </div>
              )}
              <input
                type="email"
                placeholder={t('emailPlaceholder')}
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="neu-input text-fl-fg placeholder:text-fl-muted-4 w-full px-4 py-3 font-mono text-xs"
              />
              <button
                type="submit"
                disabled={loading}
                className="neu-button-primary w-full py-3 font-mono text-sm font-bold tracking-widest uppercase disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                    {t('sending')}
                  </>
                ) : (
                  t('submit')
                )}
              </button>
              <Link
                href="/login"
                className="text-fl-muted-4 hover:text-fl-muted-2 block text-center font-mono text-xs transition-colors"
              >
                {t('backToLogin')}
              </Link>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
