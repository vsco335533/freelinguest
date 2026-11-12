'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useLanguageStore } from '@/store/language'
import { useAuthStore } from '@/store/auth'
import {
  getLanguageByCode,
  TARGET_LANGUAGE_CATALOG,
} from '@/lib/target-languages'
import TargetLanguageSelector from '@/components/TargetLanguageSelector'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { PageLoading } from '@/components/ui/page-loading'
import type { UserLanguageInfo } from '@/store/language'

export default function MyLanguagesPage() {
  const locale = useLocale()
  const t = useTranslations('languages')
  const tTarget = useTranslations('targetLanguages')
  const tSettings = useTranslations('settings')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const userLanguages = useLanguageStore((s) => s.userLanguages)
  const needsRefresh = useLanguageStore((s) => s.needsRefresh)
  const isSwitching = useLanguageStore((s) => s.isSwitching)
  const fetchLanguages = useLanguageStore((s) => s.fetchLanguages)
  const switchLanguage = useLanguageStore((s) => s.switchLanguage)
  const addLanguage = useLanguageStore((s) => s.addLanguage)
  const removeLanguage = useLanguageStore((s) => s.removeLanguage)
  const sessionVersion = useAuthStore((s) => s.sessionVersion)

  const [addModalOpen, setAddModalOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<UserLanguageInfo | null>(
    null
  )
  const [addingCode, setAddingCode] = useState('')
  const [switchingCode, setSwitchingCode] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  const load = useCallback(() => setAttempt((value) => value + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setFailed(false)
    void fetchLanguages(controller.signal).then((ok) => {
      if (controller.signal.aborted) return
      setFailed(!ok)
      setLoading(false)
    })
    return () => controller.abort()
  }, [fetchLanguages, attempt, sessionVersion])

  function getLangInfo(code: string) {
    return getLanguageByCode(code)
  }

  async function handleSwitch(info: UserLanguageInfo) {
    if (info.is_active || useLanguageStore.getState().isSwitching) return
    setSwitchingCode(info.target_language)
    setToast('')
    const ok = await switchLanguage(info.target_language)
    setSwitchingCode(null)
    if (ok) {
      const level = info.plan?.cefr_level ?? ''
      setToast(
        t('switched', { language: tTarget(info.target_language), level })
      )
      setTimeout(() => setToast(''), 2500)
      router.refresh()
    } else {
      setToast(tCommon('errorMessage'))
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    const ok = await removeLanguage(deleteTarget.target_language)
    if (!ok) {
      setToast(
        t('deleteError', {
          language: tTarget(deleteTarget.target_language),
        })
      )
      setDeleteTarget(null)
      return
    }
    setDeleteTarget(null)
  }

  async function handleAdd() {
    if (!addingCode) return
    const ok = await addLanguage(addingCode)
    if (!ok) return
    setAddModalOpen(false)
    setAddingCode('')
    router.push(`/assessment`)
  }

  const availableLanguageCodes = useLanguageStore(
    (s) => s.availableLanguageCodes
  )
  const addedCodes = userLanguages.map((ul) => ul.target_language)
  // Only show operator-enabled languages that the user hasn't added yet
  const unusedCodes = TARGET_LANGUAGE_CATALOG.filter(
    (l) =>
      availableLanguageCodes.includes(l.code) && !addedCodes.includes(l.code)
  ).map((l) => l.code)
  const hasMultiple = userLanguages.length > 1

  return (
    <div className="mx-auto max-w-4xl p-6">
      {needsRefresh && !switchingCode && !failed && (
        <button
          onClick={load}
          disabled={loading}
          className="text-fl-muted-2 hover:text-fl-fg mb-4 text-xs disabled:opacity-50"
        >
          {tCommon('retry')}
        </button>
      )}
      {/* Toast */}
      {toast && (
        <div className="pointer-events-none fixed inset-x-0 top-16 z-50 flex justify-center">
          <div className="animate-in fade-in slide-in-from-top-2 neu-glass-card text-fl-fg pointer-events-auto rounded-full px-5 py-2.5 font-mono text-xs font-semibold tracking-widest uppercase motion-reduce:animate-none">
            {toast}
          </div>
        </div>
      )}

      {/* Breadcrumb */}
      <nav className="text-fl-label text-fl-muted-2 mb-8 flex items-center gap-2 font-mono font-semibold">
        <Link
          href="/settings"
          className="hover:text-fl-fg tracking-widest uppercase transition-colors"
        >
          {tSettings('title')}
        </Link>
        <span>›</span>
        <span className="text-fl-fg font-bold tracking-widest uppercase">
          {t('myLanguages')}
        </span>
      </nav>

      {/* Header + Add button */}
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-fl-fg font-mono text-xl font-bold tracking-widest uppercase">
          {t('myLanguages')}
        </h1>
        {!loading && !failed && unusedCodes.length > 0 && (
          <button
            onClick={() => setAddModalOpen(true)}
            className="neu-button-primary rounded-xl px-4 py-2 font-mono text-sm font-bold tracking-widest uppercase transition-all"
          >
            + {t('addLanguage')}
          </button>
        )}
      </div>

      {/* Language cards */}
      {loading ? (
        <PageLoading fullScreen={false} />
      ) : failed ? (
        <div className="glass-card space-y-3 rounded-2xl p-6">
          <p role="alert" className="text-fl-error-fg text-sm font-semibold">
            {tCommon('errorMessage')}
          </p>
          <button
            type="button"
            onClick={load}
            className="neu-button rounded-xl px-4 py-2 text-sm font-semibold"
          >
            {tCommon('retry')}
          </button>
        </div>
      ) : userLanguages.length === 0 ? (
        <div className="glass-card rounded-2xl px-6 py-10 text-center">
          <p className="text-fl-muted-2 font-mono text-sm font-semibold">
            {t('noLanguages')}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {[...userLanguages]
            .sort((a, b) =>
              tTarget(a.target_language).localeCompare(
                tTarget(b.target_language)
              )
            )
            .map((ulang) => {
              const lang = getLangInfo(ulang.target_language)
              const isActive = ulang.is_active
              const plan = ulang.plan
              const progress = ulang.progress

              return (
                <div
                  key={ulang.target_language}
                  className={`rounded-2xl p-5 ${
                    isActive
                      ? 'neu-glass-card ring-fl-accent/40 ring-2'
                      : 'glass-card'
                  }`}
                >
                  {/* Top row: flag + name + status */}
                  <div className="mb-3 flex items-center gap-3">
                    {lang && (
                      <Image
                        src={lang.flagPath}
                        alt={lang.code}
                        width={28}
                        height={20}
                        className="shrink-0 rounded-sm object-cover"
                      />
                    )}
                    <span className="text-fl-fg flex-1 font-mono text-sm font-bold">
                      {tTarget(ulang.target_language)}
                    </span>
                    {isActive ? (
                      <span className="text-fl-label bg-fl-accent/15 text-fl-accent rounded-full px-3 py-0.5 font-mono text-xs font-bold tracking-widest uppercase">
                        {t('activeLanguage')}
                      </span>
                    ) : plan?.cefr_level ? (
                      <span className="text-fl-label glass-card text-fl-fg rounded-full px-2.5 py-0.5 font-mono font-semibold tracking-widest uppercase">
                        {plan.cefr_level}
                      </span>
                    ) : null}
                  </div>

                  {/* Stats */}
                  {plan && (
                    <div className="text-fl-muted-2 mb-3 flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs font-medium">
                      <span>
                        {t('levelLabel')}: {plan.cefr_level ?? '—'}
                      </span>
                      <span>
                        {t('progressLabel')}: {plan.completion_pct}%
                      </span>
                      {progress && (
                        <>
                          <span>
                            {t('xpLabel')}:{' '}
                            {progress.total_xp.toLocaleString(locale)}
                          </span>
                          <span>
                            {t('streakLabel')}: {progress.current_streak}d
                          </span>
                          <span>
                            {t('lessonsLabel')}: {progress.lessons_completed}
                          </span>
                        </>
                      )}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex flex-wrap items-center gap-2">
                    {isActive ? (
                      <button
                        onClick={() => router.push(`/plan`)}
                        className="neu-button text-fl-label text-fl-fg rounded-xl px-3.5 py-1.5 font-mono text-xs font-semibold tracking-widest uppercase transition-all"
                      >
                        {t('viewDetails')} →
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={() => handleSwitch(ulang)}
                          disabled={isSwitching}
                          className="neu-button-primary rounded-xl px-3.5 py-1.5 font-mono text-xs font-bold tracking-widest uppercase transition-all disabled:opacity-40"
                        >
                          {switchingCode === ulang.target_language
                            ? '...'
                            : t('switchTo')}
                        </button>
                        {hasMultiple && (
                          <button
                            onClick={() => setDeleteTarget(ulang)}
                            className="neu-button text-fl-label text-fl-muted-2 hover:text-fl-error rounded-xl px-3.5 py-1.5 font-mono text-xs font-semibold tracking-widest uppercase transition-all"
                          >
                            {t('removeLanguage')}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )
            })}
        </div>
      )}

      {/* Add language modal */}
      {addModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <div className="neu-glass-card w-full max-w-lg rounded-3xl p-6">
            <h2 className="text-fl-fg mb-4 font-mono text-sm font-bold tracking-widest uppercase">
              {t('selectLanguage')}
            </h2>
            <TargetLanguageSelector
              value={addingCode}
              onChange={setAddingCode}
              availableCodes={unusedCodes}
            />
            <div className="mt-5 flex justify-end gap-2.5">
              <button
                onClick={() => setAddModalOpen(false)}
                className="neu-button text-fl-label text-fl-fg rounded-xl px-4 py-2 font-mono text-xs font-semibold tracking-widest uppercase transition-all"
              >
                {tCommon('cancel')}
              </button>
              <button
                onClick={handleAdd}
                disabled={!addingCode}
                className="neu-button-primary rounded-xl px-4 py-2 font-mono text-sm font-bold tracking-widest uppercase transition-all disabled:opacity-40"
              >
                {t('addLanguage')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('removeConfirmTitle', {
          language: deleteTarget ? tTarget(deleteTarget.target_language) : '',
        })}
        message={t('removeConfirmMessage')}
        confirmLabel={t('removeConfirmButton')}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
