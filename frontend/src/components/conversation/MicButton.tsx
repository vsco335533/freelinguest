import { useTranslations } from 'next-intl'
import type { ConvStatus } from './StatusIndicator'

interface Props {
  status: ConvStatus
  sessionActive?: boolean
  onStart: () => void
  onStop: () => void
}

export default function MicButton({ status, onStart, onStop }: Props) {
  const t = useTranslations('conversation')

  if (status === 'loading') {
    return (
      <button
        disabled
        className="neu-card flex h-16 w-16 items-center justify-center rounded-full opacity-50"
        aria-label={t('statusLoading')}
      >
        <span className="text-fl-muted-2 animate-pulse font-mono text-xl">
          ◌
        </span>
      </button>
    )
  }

  if (status === 'connecting') {
    return (
      <button
        disabled
        className="neu-card flex h-16 w-16 items-center justify-center rounded-full opacity-75"
        aria-label={t('statusConnecting')}
      >
        <span className="text-fl-muted-1 animate-pulse font-mono text-xl">
          ○
        </span>
      </button>
    )
  }

  if (status === 'ready') {
    return (
      <button
        onClick={() => onStart()}
        className="neu-button-primary rounded-full px-9 py-3.5 font-mono text-sm font-bold tracking-widest text-white uppercase"
      >
        {t('start')}
      </button>
    )
  }

  if (status === 'live' || status === 'warming') {
    return (
      <button
        onClick={onStop}
        className="neu-card border-fl-error/60 hover:bg-fl-error/10 group flex h-16 w-16 items-center justify-center rounded-full border-2 transition-all"
        aria-label={t('stop')}
        title={t('stop')}
      >
        <span className="text-fl-error font-mono text-lg transition-transform group-hover:scale-110">
          ■
        </span>
      </button>
    )
  }

  // ended or error → offer restart
  return (
    <button
      onClick={() => onStart()}
      className="neu-button text-fl-fg rounded-full px-8 py-3 font-mono text-sm font-bold tracking-widest uppercase"
    >
      {t('startNew')}
    </button>
  )
}
