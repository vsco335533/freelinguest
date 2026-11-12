import { useTranslations } from 'next-intl'
import { TargetLanguageText } from '@/components/TargetLanguageText'
import { AuthAvatarImage } from '@/components/AuthAvatarImage'
import { LinguistLogoMark } from '@/components/ui/LinguistLogoMark'

interface Props {
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  speaking?: boolean
  userAvatar?: string | null
  userInitial?: string
  languageCode?: string | null
  onPointerUp?: () => void
}

export default function TranscriptBubble({
  role,
  text,
  streaming = false,
  speaking = false,
  userAvatar,
  userInitial,
  languageCode,
  onPointerUp,
}: Props) {
  const t = useTranslations('conversation')
  const isUser = role === 'user'

  return (
    <div
      className={`flex items-end gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
    >
      {/* Avatar */}
      <div className="relative mb-0.5 flex-shrink-0">
        <span
          className={`pointer-events-none absolute inset-[-5px] rounded-full border-2 transition-[border-color,opacity] duration-700 motion-reduce:animate-none motion-reduce:transition-none ${speaking
              ? 'border-fl-accent/65 animate-halo-speaking'
              : 'border-fl-accent/15'
            }`}
        />
        <div className="border-fl-border h-7 w-7 overflow-hidden rounded-full border">
          {!isUser ? (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-sky-100 to-blue-200 dark:from-sky-900/60 dark:to-blue-950">
              <LinguistLogoMark size={20} />
            </div>
          ) : userAvatar ? (
            <AuthAvatarImage
              avatar={userAvatar}
              alt=""
              width={28}
              height={28}
              className="h-full w-full object-cover"
              fallback={
                <div className="bg-fl-surface-2 flex h-full w-full items-center justify-center">
                  <span className="text-fl-hint text-fl-muted-1 font-mono select-none">
                    {(userInitial ?? '?').toUpperCase()}
                  </span>
                </div>
              }
            />
          ) : (
            <div className="bg-fl-surface-2 flex h-full w-full items-center justify-center">
              <span className="text-fl-hint text-fl-muted-1 font-mono select-none">
                {(userInitial ?? '?').toUpperCase()}
              </span>
            </div>
          )}
        </div>
      </div>

      <div
        className={`flex max-w-[75%] flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}
      >
        <span className="text-fl-caption text-fl-muted-1 font-sans tracking-wide uppercase">
          {isUser ? t('you') : t('assistant')}
        </span>
        <TargetLanguageText
          as="div"
          languageCode={languageCode}
          className={`max-w-[70ch] rounded-2xl border px-4 py-3 ${onPointerUp ? 'word-selectable cursor-text select-text' : ''
            } ${isUser
              ? 'neu-button-primary border-blue-400/40'
              : 'glass-card text-fl-fg'
            }`}
          onPointerUp={onPointerUp}
        >
          {text}
          {streaming && (
            <span className="ml-1 inline-block h-3 w-1 animate-pulse bg-current align-middle motion-reduce:animate-none" />
          )}
        </TargetLanguageText>
      </div>
    </div>
  )
}
