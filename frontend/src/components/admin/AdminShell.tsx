'use client'

import { type ReactNode } from 'react'
import { type LucideIcon } from 'lucide-react'

interface AdminPageHeaderProps {
  title: string
  eyebrow: string
  actions?: ReactNode
}

export function AdminPageHeader({
  title,
  eyebrow,
  actions,
}: AdminPageHeaderProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-fl-accent text-fl-label">●</span>
          <span className="text-fl-fg font-mono text-xs font-semibold tracking-widest uppercase">
            {eyebrow}
          </span>
        </div>
        <h1 className="text-fl-fg font-mono text-xl font-bold tracking-normal">
          {title}
        </h1>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

export function AdminPanel({
  title,
  meta,
  children,
}: {
  title?: string
  meta?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="glass-card overflow-hidden rounded-2xl">
      {(title || meta) && (
        <div className="border-fl-border/60 flex flex-wrap items-center gap-2 border-b px-5 py-4">
          {title && (
            <>
              <span className="text-fl-accent text-fl-label">●</span>
              <span className="text-fl-label text-fl-fg font-mono font-bold tracking-widest uppercase">
                {title}
              </span>
            </>
          )}
          {meta && <div className="ml-auto">{meta}</div>}
        </div>
      )}
      {children}
    </div>
  )
}

export function AdminMetric({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: ReactNode
  icon: LucideIcon
}) {
  return (
    <div className="glass-card flex items-center justify-between gap-3 rounded-2xl px-4 py-3.5">
      <div className="min-w-0">
        <p className="text-fl-label text-fl-muted-3 mb-1 font-mono font-semibold tracking-widest uppercase">
          {label}
        </p>
        <p className="text-fl-fg truncate font-mono text-lg font-bold">
          {value}
        </p>
      </div>
      <Icon className="text-fl-accent size-5 shrink-0" aria-hidden="true" />
    </div>
  )
}

export function AdminBadge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger'
}) {
  const toneClass = {
    neutral: 'border-fl-border text-fl-muted-2 bg-white/40 dark:bg-white/5',
    info: 'border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300',
    success:
      'border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-300',
    warning:
      'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    danger: 'border-fl-error/40 bg-fl-error/10 text-fl-error-fg',
  }[tone]

  return (
    <span
      className={`text-fl-hint inline-flex rounded-full border px-2.5 py-0.5 font-mono font-semibold tracking-widest uppercase ${toneClass}`}
    >
      {children}
    </span>
  )
}
