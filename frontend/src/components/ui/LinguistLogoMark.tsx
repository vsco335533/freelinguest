'use client'

import React from 'react'

interface LinguistLogoMarkProps {
  size?: number
  className?: string
  animated?: boolean
}

export function LinguistLogoMark({
  size = 32,
  className = '',
  animated = false,
}: LinguistLogoMarkProps) {
  return (
    <svg
      viewBox="300 60 1376 1110"
      width={size}
      height={size}
      className={`shrink-0 overflow-visible transition-transform duration-300 ${
        animated ? 'hover:scale-105' : ''
      } ${className}`}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="ln-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#2563eb" />
        </linearGradient>
      </defs>

      {/* Sound waves (left & right) */}
      <path
        className={animated ? 'animate-pulse' : ''}
        fill="none"
        stroke="#38bdf8"
        strokeWidth="24"
        strokeLinecap="round"
        opacity="0.8"
        d="M360,600 Q320,700 360,800"
      />
      <path
        className={animated ? 'animate-pulse' : ''}
        fill="none"
        stroke="#38bdf8"
        strokeWidth="24"
        strokeLinecap="round"
        opacity="0.5"
        d="M320,560 Q260,700 320,840"
      />
      <path
        className={animated ? 'animate-pulse' : ''}
        fill="none"
        stroke="#38bdf8"
        strokeWidth="24"
        strokeLinecap="round"
        opacity="0.8"
        d="M1616,600 Q1656,700 1616,800"
      />
      <path
        className={animated ? 'animate-pulse' : ''}
        fill="none"
        stroke="#38bdf8"
        strokeWidth="24"
        strokeLinecap="round"
        opacity="0.5"
        d="M1656,560 Q1716,700 1656,840"
      />

      {/* Headband */}
      <path
        fill="none"
        stroke="url(#ln-grad)"
        strokeWidth="92"
        strokeLinecap="butt"
        d="M537,438 A486,486 0 0 1 1439,438"
      />

      {/* Ear cups */}
      <path
        fill="#2563eb"
        d="M515,508 C455,512 415,545 415,600 V820 C415,870 460,895 520,895 C495,820 490,760 490,700 C490,640 495,570 515,508 Z"
      />
      <path
        fill="#2563eb"
        d="M1461,508 C1521,512 1561,545 1561,600 V820 C1561,870 1516,895 1456,895 C1481,820 1486,760 1486,700 C1486,640 1481,570 1461,508 Z"
      />

      {/* Face background */}
      <g>
        <circle
          cx="988"
          cy="695"
          r="423"
          fill="#ffffff"
          stroke="#bfdbfe"
          strokeWidth="14"
        />

        {/* Eyes */}
        <g className="eye-left">
          <circle cx="771" cy="581" r="120" fill="#1d4ed8" />
          <circle cx="769" cy="580" r="55" fill="#38bdf8" />
          <circle cx="743" cy="552" r="22" fill="#ffffff" />
        </g>
        <g className="eye-right">
          <circle cx="1206" cy="581" r="120" fill="#1d4ed8" />
          <circle cx="1204" cy="580" r="55" fill="#38bdf8" />
          <circle cx="1178" cy="552" r="22" fill="#ffffff" />
        </g>

        {/* Nose */}
        <rect
          x="955"
          y="532"
          width="65"
          height="348"
          rx="32"
          fill="#1d4ed8"
        />

        {/* Smile */}
        <path
          fill="#1d4ed8"
          d="M820,912 L878,912 Q990,1000 1105,912 L1163,912 C1120,1010 1060,1035 990,1035 C918,1035 860,1010 820,912 Z"
        />
      </g>
    </svg>
  )
}

