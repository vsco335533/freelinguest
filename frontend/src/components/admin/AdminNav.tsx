'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  LayoutDashboard,
  MessageSquareText,
  Settings,
  Star,
  Users,
} from 'lucide-react'

const items = [
  { href: '/admin', key: 'overview', icon: LayoutDashboard },
  { href: '/admin/users', key: 'users', icon: Users },
  { href: '/admin/feedback', key: 'feedback', icon: MessageSquareText },
  { href: '/admin/reviews', key: 'reviews', icon: Star },
  { href: '/admin/system', key: 'system', icon: Settings },
] as const

export function AdminNav() {
  const pathname = usePathname()
  const t = useTranslations('admin')

  return (
    <div className="glass-card flex flex-wrap items-center gap-1.5 rounded-2xl p-1.5">
      {items.map((item) => {
        const Icon = item.icon
        const active =
          pathname === item.href ||
          (item.href !== '/admin' && pathname.startsWith(`${item.href}/`))
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex min-h-9 items-center gap-2 rounded-xl px-3.5 py-2 font-mono text-xs font-semibold tracking-widest uppercase transition-all ${
              active
                ? 'neu-button-primary'
                : 'text-fl-muted-2 hover:text-fl-fg hover:bg-white/60 dark:hover:bg-white/10'
            }`}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {t(item.key)}
          </Link>
        )
      })}
    </div>
  )
}
