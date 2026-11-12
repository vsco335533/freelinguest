'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2, Star, X } from 'lucide-react'
import { createReview, fetchMyReview } from '@/lib/reviews'
import type { ReviewAdmin } from '@/types/api'

const DISMISS_KEY = 'freelingo:reviewPromptDismissed'

export function getReviewPromptDismissal(): {
  count: number
  lastDismissedAt: number
} {
  if (typeof window === 'undefined') return { count: 0, lastDismissedAt: 0 }
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY)
    if (!raw) return { count: 0, lastDismissedAt: 0 }
    const parsed = JSON.parse(raw) as {
      count?: number
      lastDismissedAt?: number
    }
    return {
      count: Number(parsed.count) || 0,
      lastDismissedAt: Number(parsed.lastDismissedAt) || 0,
    }
  } catch {
    return { count: 0, lastDismissedAt: 0 }
  }
}

export function recordReviewPromptDismissal(): void {
  if (typeof window === 'undefined') return
  const current = getReviewPromptDismissal()
  window.localStorage.setItem(
    DISMISS_KEY,
    JSON.stringify({ count: current.count + 1, lastDismissedAt: Date.now() })
  )
}

interface ReviewPromptProps {
  open: boolean
  onClose: () => void
  onSubmitted?: (review: ReviewAdmin) => void
}

interface ReviewFormProps {
  initialReview?: ReviewAdmin | null
  submitLabel?: string
  cancelLabel?: string
  onCancel?: () => void
  onSubmit: (data: { rating: number; comment?: string }) => Promise<ReviewAdmin>
}

export function ReviewForm({
  initialReview,
  submitLabel,
  cancelLabel,
  onCancel,
  onSubmit,
}: ReviewFormProps) {
  const t = useTranslations('reviewPrompt')
  const tStars = useTranslations('landingReviews')
  const [rating, setRating] = useState(initialReview?.rating ?? 0)
  const [comment, setComment] = useState(initialReview?.comment ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setRating(initialReview?.rating ?? 0)
    setComment(initialReview?.comment ?? '')
  }, [initialReview])

  async function handleSubmit() {
    if (!rating) {
      setError(t('ratingRequiredError'))
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await onSubmit({ rating, comment: comment.trim() || undefined })
    } catch {
      setError(t('saveError'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div className="space-y-5 px-5 py-5">
        <div>
          <p className="text-fl-label text-fl-fg mb-3 font-mono font-bold tracking-widest uppercase">
            {t('ratingLabel')}
          </p>
          <div
            className="flex gap-2"
            role="radiogroup"
            aria-label={t('ratingGroupLabel')}
          >
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={rating === value}
                aria-label={tStars('starsLabel', { rating: value })}
                onClick={() => setRating(value)}
                className={`rounded-xl px-3.5 py-2.5 transition-all ${
                  value <= rating
                    ? 'neu-card text-amber-500 ring-2 ring-amber-400/60'
                    : 'neu-button text-fl-muted-2 hover:text-fl-fg'
                }`}
              >
                <Star className="size-5 fill-current" />
              </button>
            ))}
          </div>
        </div>

        <div>
          <label
            htmlFor="review-comment"
            className="text-fl-fg mb-2 block font-mono text-xs font-semibold tracking-widest uppercase"
          >
            {t('commentLabel')}
          </label>
          <textarea
            id="review-comment"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            maxLength={2000}
            rows={4}
            className="neu-input text-fl-fg placeholder:text-fl-muted-3 w-full resize-none rounded-xl px-3.5 py-2.5 font-mono text-sm font-medium outline-none"
            placeholder={t('commentPlaceholder')}
          />
        </div>

        {error && (
          <p className="text-fl-error-fg font-mono text-xs font-semibold">
            {error}
          </p>
        )}
      </div>

      <div className="flex gap-2.5 px-5 pb-5">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="neu-button text-fl-fg flex-1 rounded-xl py-3 font-mono text-xs font-bold tracking-widest uppercase transition-all"
          >
            {cancelLabel ?? t('cancel')}
          </button>
        )}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className="neu-button-primary flex flex-1 items-center justify-center gap-2 rounded-xl py-3 font-mono text-sm font-bold tracking-widest uppercase transition-all disabled:opacity-60"
        >
          {submitting && <Loader2 className="size-3.5 animate-spin" />}
          {submitLabel ?? t('submit')}
        </button>
      </div>
    </>
  )
}

export function ReviewPrompt({
  open,
  onClose,
  onSubmitted,
}: ReviewPromptProps) {
  const t = useTranslations('reviewPrompt')
  const [checking, setChecking] = useState(true)
  const [hasReview, setHasReview] = useState(false)
  const [error, setError] = useState('')
  const [statusCheckFailed, setStatusCheckFailed] = useState(false)

  useEffect(() => {
    if (!open) {
      setChecking(true)
      setHasReview(false)
      return
    }
    let cancelled = false
    setChecking(true)
    setError('')
    setStatusCheckFailed(false)
    fetchMyReview()
      .then((data) => {
        if (cancelled) return
        setHasReview(data.has_review)
      })
      .catch(() => {
        if (cancelled) return
        setStatusCheckFailed(true)
        setError(t('statusError'))
      })
      .finally(() => {
        if (!cancelled) setChecking(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, t])

  if (!open || hasReview) return null

  function handleCancel() {
    recordReviewPromptDismissal()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[180] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="neu-glass-card w-full max-w-md overflow-hidden rounded-3xl">
        <div className="border-fl-border/60 flex items-center justify-between border-b px-5 py-4">
          <div>
            <p className="text-fl-label text-fl-accent font-mono font-bold tracking-widest uppercase">
              {t('eyebrow')}
            </p>
            <h2 className="text-fl-fg mt-1 font-sans text-lg font-bold tracking-tight">
              {t('title')}
            </h2>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            className="neu-button text-fl-fg rounded-full p-2 transition-all"
            aria-label={t('closeLabel')}
          >
            <X className="size-4" />
          </button>
        </div>

        {checking ? (
          <div className="px-5 py-5">
            <div className="text-fl-muted-2 flex items-center gap-2 font-mono text-xs font-medium">
              <Loader2 className="size-4 animate-spin" /> {t('checking')}
            </div>
          </div>
        ) : statusCheckFailed ? (
          <div className="px-5 py-5">
            <p className="text-fl-error-fg font-mono text-xs font-semibold">
              {error}
            </p>
          </div>
        ) : (
          <ReviewForm
            onCancel={handleCancel}
            onSubmit={async (data) => {
              const review = await createReview(data)
              onSubmitted?.(review)
              onClose()
              return review
            }}
          />
        )}
      </div>
    </div>
  )
}
