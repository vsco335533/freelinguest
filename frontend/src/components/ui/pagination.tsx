'use client'

import { useEffect, useRef } from 'react'
import { useLoadingStore } from '@/store/loading'

interface PaginationProps {
  /** 0-indexed current page. */
  page: number
  /** Total number of pages. */
  totalPages: number
  /** Disables buttons during fetch. */
  loading?: boolean
  /** Called with the new 0-indexed page number. */
  onPageChange: (page: number) => void
  /** Translated text for the previous button. */
  prevLabel: string
  /** Translated text for the next button. */
  nextLabel: string
  /** Pre-formatted page info shown between buttons (e.g. "2 / 5"). Falls back to "page+1 / totalPages". */
  pageInfo?: string
  /** Extra classes for the outer container. */
  className?: string
}

export function Pagination({
  page,
  totalPages,
  loading = false,
  onPageChange,
  prevLabel,
  nextLabel,
  pageInfo,
  className = '',
}: PaginationProps) {
  const incDone = useRef(false)

  useEffect(() => {
    if (loading && !incDone.current) {
      incDone.current = true
      useLoadingStore.getState().inc()
    }
    if (!loading && incDone.current) {
      useLoadingStore.getState().dec()
      incDone.current = false
    }
    return () => {
      if (incDone.current) {
        useLoadingStore.getState().dec()
        incDone.current = false
      }
    }
  }, [loading])

  if (totalPages <= 1) return null

  const isFirst = page <= 0
  const isLast = page >= totalPages - 1
  const isDisabled = loading

  const info = pageInfo ?? `${page + 1} / ${totalPages}`

  return (
    <div
      className={`glass-card flex items-center justify-between rounded-2xl px-6 py-3.5 ${className}`}
    >
      <button
        onClick={() => onPageChange(Math.max(0, page - 1))}
        disabled={isFirst || isDisabled}
        className="neu-button text-fl-muted-1 hover:text-fl-fg rounded-xl px-4 py-2 font-mono text-xs font-bold tracking-widest uppercase disabled:cursor-not-allowed disabled:opacity-30"
      >
        {prevLabel}
      </button>
      <span className="text-fl-label text-fl-muted-2 font-mono font-bold tracking-widest">
        {info}
      </span>
      <button
        onClick={() => onPageChange(page + 1)}
        disabled={isLast || isDisabled}
        className="neu-button text-fl-muted-1 hover:text-fl-fg rounded-xl px-4 py-2 font-mono text-xs font-bold tracking-widest uppercase disabled:cursor-not-allowed disabled:opacity-30"
      >
        {nextLabel}
      </button>
    </div>
  )
}
