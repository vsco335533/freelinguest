import Link from 'next/link'
import { LinguistLogoMark } from '@/components/ui/LinguistLogoMark'

interface LinguistBrandHeaderProps {
  subtitle?: string
  href?: string
  asHeading?: boolean
  size?: number
  className?: string
}

/**
 * Shared neomorphic + glass brand lockup rendering the Linguist headphones mark.
 */
export function LinguistBrandHeader({
  subtitle,
  href,
  asHeading = true,
  size = 56,
  className = 'mb-8',
}: LinguistBrandHeaderProps) {
  const logo = (
    <div className="neu-logo-badge mb-4 flex items-center justify-center rounded-3xl p-4">
      <LinguistLogoMark size={size} animated />
    </div>
  )

  return (
    <div className={`flex flex-col items-center text-center ${className}`}>
      {href ? (
        <Link
          href={href}
          className="rounded-3xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-500"
          aria-label="Linguist"
        >
          {logo}
        </Link>
      ) : (
        logo
      )}
      {asHeading ? (
        <h1 className="text-fl-fg font-code text-xl font-bold tracking-widest uppercase">
          Linguist
        </h1>
      ) : (
        <p className="text-fl-fg font-code text-xl font-bold tracking-widest uppercase">
          Linguist
        </p>
      )}
      {subtitle && (
        <p className="text-fl-caption text-fl-muted-2 mt-1.5 font-mono tracking-widest uppercase">
          {subtitle}
        </p>
      )}
    </div>
  )
}

/**
 * Soft ambient blue-and-white blurred glow orbs for auth and utility backdrops.
 */
export function AuthBackdropOrbs() {
  return (
    <div
      className="pointer-events-none fixed inset-0 overflow-hidden"
      aria-hidden="true"
    >
      <div className="absolute -top-32 -left-24 h-96 w-96 rounded-full bg-sky-400/25 blur-3xl dark:bg-sky-500/15" />
      <div className="absolute top-1/3 -right-28 h-[28rem] w-[28rem] rounded-full bg-blue-500/20 blur-3xl dark:bg-blue-600/20" />
      <div className="absolute -bottom-32 left-1/4 h-80 w-80 rounded-full bg-white/70 blur-3xl dark:bg-indigo-500/10" />
    </div>
  )
}

