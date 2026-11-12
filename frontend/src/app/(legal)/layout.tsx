import type { ReactNode } from 'react'
import { AuthBackdropOrbs } from '@/components/ui/LinguistBrandHeader'

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <main className="fl-gradient-bg relative min-h-screen px-4 py-12">
      <AuthBackdropOrbs />
      <div className="relative z-10 mx-auto max-w-2xl">{children}</div>
    </main>
  )
}
