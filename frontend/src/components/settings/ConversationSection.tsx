'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { apiFetch } from '@/lib/api'
import { mapUser } from '@/lib/mappers'
import { useAuthStore } from '@/store/auth'
import { SPEECH_PAUSE_OPTIONS, type SpeechPause } from '@/lib/conversation-vad'

export function ConversationSection({ title }: { title?: string } = {}) {
  const t = useTranslations('settings')
  const user = useAuthStore((s) => s.user)
  const setUser = useAuthStore((s) => s.setUser)

  const [convMaxDuration, setConvMaxDuration] = useState<900 | 1800>(1800)
  const [convInactivityTimeout, setConvInactivityTimeout] = useState<
    60 | 180 | 300
  >(180)
  const [convSpeechPause, setConvSpeechPause] = useState<SpeechPause>(0)
  const [convMessage, setConvMessage] = useState<{
    type: 'ok' | 'err'
    text: string
  } | null>(null)
  const [savingConv, setSavingConv] = useState(false)

  useEffect(() => {
    if (user) {
      setConvMaxDuration((user.conversation_max_duration as 900 | 1800) || 1800)
      setConvInactivityTimeout(
        (user.conversation_inactivity_timeout as 60 | 180 | 300) || 180
      )
      setConvSpeechPause((user.conversation_speech_pause as SpeechPause) || 0)
    }
  }, [user])

  async function handleSaveConversation() {
    const { sessionVersion } = useAuthStore.getState()
    setSavingConv(true)
    setConvMessage(null)
    try {
      const res = await apiFetch('/api/auth/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_max_duration: convMaxDuration,
          conversation_inactivity_timeout: convInactivityTimeout,
          conversation_speech_pause: convSpeechPause,
        }),
      })
      if (!res.ok) throw new Error(t('saveFailed'))
      const updated = await res.json()
      if (useAuthStore.getState().sessionVersion !== sessionVersion) return
      setUser(mapUser(updated, user))
      setConvMessage({ type: 'ok', text: t('conversationSaved') })
    } catch {
      setConvMessage({
        type: 'err',
        text: t('saveFailed'),
      })
    } finally {
      setSavingConv(false)
    }
  }

  return (
    <div className="glass-card rounded-2xl p-6">
      <div className="border-fl-border/60 mb-5 flex items-center gap-2 border-b pb-4">
        <span className="text-fl-accent text-fl-label">●</span>
        <span className="text-fl-label text-fl-fg font-mono font-bold tracking-widest uppercase">
          {title ?? t('sectionConversation')}
        </span>
      </div>

      <div className="space-y-5">
        <div>
          <label className="text-fl-fg mb-2 block font-mono text-xs font-semibold tracking-widest uppercase">
            {t('conversationMaxDuration')}
          </label>
          <div className="flex gap-2">
            {([900, 1800] as const).map((val) => (
              <button
                key={val}
                type="button"
                onClick={() => setConvMaxDuration(val)}
                className={`flex-1 rounded-xl py-3 font-mono text-xs font-semibold tracking-widest uppercase transition-all ${convMaxDuration === val
                    ? 'neu-button-primary'
                    : 'neu-button text-fl-muted-2 hover:text-fl-fg'
                  }`}
              >
                {val === 900 ? t('min15') : t('min30')}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-fl-fg mb-2 block font-mono text-xs font-semibold tracking-widest uppercase">
            {t('conversationInactivityTimeout')}
          </label>
          <div className="flex gap-2">
            {([60, 180, 300] as const).map((val) => (
              <button
                key={val}
                type="button"
                onClick={() => setConvInactivityTimeout(val)}
                className={`flex-1 rounded-xl py-3 font-mono text-xs font-semibold tracking-widest uppercase transition-all ${convInactivityTimeout === val
                    ? 'neu-button-primary'
                    : 'neu-button text-fl-muted-2 hover:text-fl-fg'
                  }`}
              >
                {val === 60 ? t('min1') : val === 180 ? t('min3') : t('min5')}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-fl-fg mb-2 block font-mono text-xs font-semibold tracking-widest uppercase">
            {t('conversationSpeechPause')}
          </label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {SPEECH_PAUSE_OPTIONS.map((val) => (
              <button
                key={val}
                type="button"
                onClick={() => setConvSpeechPause(val)}
                className={`rounded-xl py-3 font-mono text-xs font-semibold tracking-widest uppercase transition-all ${convSpeechPause === val
                    ? 'neu-button-primary'
                    : 'neu-button text-fl-muted-2 hover:text-fl-fg'
                  }`}
              >
                {val === 0
                  ? t('speechPauseAuto')
                  : val === 1000
                    ? t('speechPauseSec1')
                    : val === 2000
                      ? t('speechPauseSec2')
                      : t('speechPauseSec3')}
              </button>
            ))}
          </div>
          <p className="text-fl-hint text-fl-muted-2 mt-2 font-mono font-medium">
            {t('conversationSpeechPauseHint')}
          </p>
        </div>

        {convMessage && (
          <div
            className={`glass-card rounded-xl border px-4 py-3 font-mono text-xs font-semibold ${convMessage.type === 'ok' ? 'border-fl-border text-fl-fg' : 'border-fl-error/40 text-fl-error'}`}
          >
            {convMessage.type === 'ok' ? '✓ ' : '✕ '}
            {convMessage.text}
          </div>
        )}

        <button
          onClick={handleSaveConversation}
          disabled={savingConv}
          className="neu-button-primary w-full rounded-xl py-3.5 font-mono text-sm font-bold tracking-widest uppercase transition-all disabled:opacity-40"
        >
          {savingConv ? t('saving') : t('saveConversation')}
        </button>
      </div>
    </div>
  )
}
