import { Mic, MicOff } from 'lucide-react'
import { useTranslations } from 'next-intl'

interface Props {
  open: boolean
}

/**
 * Tells the learner when they may speak: green while the mic listens, red while it
 * is muted for Lingu's turn (thinking, answering and playing audio).
 */
export default function MicGateIndicator({ open }: Props) {
  const t = useTranslations('conversation')
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${
        open
          ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-500'
          : 'border-fl-error/60 bg-fl-error/10 text-fl-error'
      }`}
    >
      {open ? (
        <Mic className="h-4 w-4" aria-hidden="true" />
      ) : (
        <MicOff className="h-4 w-4" aria-hidden="true" />
      )}
      <span>{open ? t('micOpenNote') : t('micMutedNote')}</span>
    </div>
  )
}
