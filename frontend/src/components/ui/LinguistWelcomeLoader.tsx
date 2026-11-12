'use client'

import React, { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { isIndicLocale } from '@/lib/curriculum-i18n'

interface LinguistWelcomeLoaderProps {
  label?: string
  onFinished?: () => void
  minDurationMs?: number
  fullScreen?: boolean
}

const WORDMARK = [...'Linguist']

export function LinguistWelcomeLoader({
  label,
  onFinished,
  minDurationMs = 5000,
  fullScreen = true,
}: LinguistWelcomeLoaderProps) {
  const [mounted, setMounted] = useState(false)
  const locale = useLocale()
  const tCommon = useTranslations('common')
  const tagline = [
    tCommon('loaderLearn'),
    tCommon('loaderSpeak'),
    tCommon('loaderRead'),
    tCommon('loaderWrite'),
  ]
  const indic = isIndicLocale(locale)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!onFinished) return
    const timer = window.setTimeout(() => onFinished(), minDurationMs)
    return () => window.clearTimeout(timer)
  }, [onFinished, minDurationMs])

  return (
    <div
      className={`${
        fullScreen
          ? 'fixed inset-0 z-50 h-dvh w-full'
          : 'relative h-full min-h-[320px] w-full rounded-2xl'
      } ln-loader flex flex-col items-center justify-center overflow-hidden p-4 select-none`}
      role="status"
      aria-label={label || tCommon('initializing')}
    >
      {/* Background glass ambient glow */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-1/4 -left-1/4 h-[60vh] w-[60vh] rounded-full bg-sky-400/20 blur-3xl animate-pulse" />
        <div className="absolute -right-1/4 -bottom-1/4 h-[60vh] w-[60vh] rounded-full bg-blue-600/30 blur-3xl animate-pulse" />
      </div>

      <div className="relative z-10 flex flex-col items-center justify-center gap-3 md:gap-4">
        <svg
          className="ln-mark drop-shadow-[0_12px_32px_rgba(0,0,0,0.22)]"
          viewBox="300 60 1376 1110"
          aria-hidden="true"
        >
          {/* Sound waves (left & right) */}
          <path className="ln-wave w1" d="M360,600 Q320,700 360,800" />
          <path className="ln-wave w2" d="M320,560 Q260,700 320,840" />
          <path className="ln-wave w1" d="M1616,600 Q1656,700 1616,800" />
          <path className="ln-wave w2" d="M1656,560 Q1716,700 1656,840" />

          {/* Headband */}
          <path
            className="ln-band"
            d="M537,438 A486,486 0 0 1 1439,438"
          />

          {/* Ear cups */}
          <path
            className="ln-cup-l"
            fill="#fff"
            d="M515,508 C455,512 415,545 415,600 V820 C415,870 460,895 520,895 C495,820 490,760 490,700 C490,640 495,570 515,508 Z"
          />
          <path
            className="ln-cup-r"
            fill="#fff"
            d="M1461,508 C1521,512 1561,545 1561,600 V820 C1561,870 1516,895 1456,895 C1481,820 1486,760 1486,700 C1486,640 1481,570 1461,508 Z"
          />

          {/* Face */}
          <g className="ln-face">
            <circle cx="988" cy="695" r="423" fill="#fff" />

            <g className="ln-eye l">
              <circle cx="771" cy="581" r="120" fill="var(--ln-blue, #2E86C1)" />
              <g className="ln-look">
                <circle cx="769" cy="580" r="55" fill="var(--ln-iris, #5BB0F7)" />
                <circle cx="743" cy="552" r="22" fill="#fff" />
              </g>
            </g>
            <g className="ln-eye r">
              <circle cx="1206" cy="581" r="120" fill="var(--ln-blue, #2E86C1)" />
              <g className="ln-look">
                <circle cx="1204" cy="580" r="55" fill="var(--ln-iris, #5BB0F7)" />
                <circle cx="1178" cy="552" r="22" fill="#fff" />
              </g>
            </g>

            <rect
              className="ln-nose"
              x="955"
              y="532"
              width="65"
              height="348"
              rx="32"
              fill="var(--ln-blue, #2E86C1)"
            />

            <path
              className="ln-smile"
              fill="var(--ln-blue, #2E86C1)"
              d="M820,912 L878,912 Q990,1000 1105,912 L1163,912 C1120,1010 1060,1035 990,1035 C918,1035 860,1010 820,912 Z"
            />
          </g>
        </svg>

        {/* Wordmark */}
        <div className="ln-word" aria-hidden="true">
          {mounted &&
            WORDMARK.map((ch, i) => (
              <span
                key={i}
                style={{ animationDelay: `${0.85 + i * 0.06}s` }}
              >
                {ch}
              </span>
            ))}
        </div>

        {/* Tagline */}
        <div
          className={indic ? 'ln-tag ln-tag-indic' : 'ln-tag'}
          aria-hidden="true"
        >
          {mounted &&
            tagline.map((w, i) => (
              <span
                key={`${w}-${i}`}
                style={{ animationDelay: `${1.35 + i * 0.14}s` }}
              >
                {w}
              </span>
            ))}
        </div>

        {/* Progress Bar */}
        <div className="ln-bar" />

        {label && (
          <p className="mt-2 font-mono text-xs tracking-widest text-white/80 uppercase animate-pulse">
            {label}
          </p>
        )}
      </div>
    </div>
  )
}

