'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import {
  AuthBackdropOrbs,
  LinguistBrandHeader,
} from '@/components/ui/LinguistBrandHeader'

function ResetPasswordContent() {
  const t = useTranslations('auth.resetPassword')
  const tCommon = useTranslations('common')
  const tRegister = useTranslations('auth.register')
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password !== confirm) {
      setError(t('mismatch'))
      return
    }
    const passwordLength = [...password].length
    if (passwordLength < 10) {
      setError(t('tooShort'))
      return
    }
    if (passwordLength > 25) {
      setError(tRegister('invalidPassword'))
      return
    }
    setLoading(true)
    try {
      const res = await apiFetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, new_password: password }),
      })
      if (!res.ok) {
        throw new Error(
          res.status === 400 || res.status === 404
            ? t('error')
            : res.status === 422
              ? tRegister('invalidPassword')
              : tCommon('errorMessage')
        )
      }
      setDone(true)
      setTimeout(() => router.push('/login'), 2000)
    } catch (err: unknown) {
      setError(
        err instanceof Error &&
          (err.message === t('error') ||
            err.message === tRegister('invalidPassword'))
          ? err.message
          : tCommon('errorMessage')
      )
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

          {done ? (
            <p className="text-fl-muted-1 font-mono text-xs leading-relaxed">
              {t('success')}
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {!token && (
                <div className="border-fl-error/40 bg-fl-error/5 text-fl-error rounded-xl border px-4 py-3 font-mono text-xs">
                  {t('missingToken')}
                </div>
              )}
              {error && (
                <div
                  role="alert"
                  className="border-fl-error/40 bg-fl-error/5 text-fl-error rounded-xl border px-4 py-3 font-mono text-xs"
                >
                  ✕ {error}
                </div>
              )}
              <input
                type="password"
                placeholder={t('newPassword')}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                aria-describedby="reset-password-requirements"
                className="neu-input text-fl-fg placeholder:text-fl-muted-4 w-full px-4 py-3 font-mono text-xs"
              />
              <p
                id="reset-password-requirements"
                className="text-fl-muted-2 font-sans text-sm leading-relaxed"
              >
                {tRegister('invalidPassword')}
              </p>
              <input
                type="password"
                placeholder={t('confirmPassword')}
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                className="neu-input text-fl-fg placeholder:text-fl-muted-4 w-full px-4 py-3 font-mono text-xs"
              />
              <button
                type="submit"
                disabled={loading || !token}
                className="neu-button-primary w-full py-3 font-mono text-sm font-bold tracking-widest uppercase disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                    {t('saving')}
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

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordContent />
    </Suspense>
  )
}
