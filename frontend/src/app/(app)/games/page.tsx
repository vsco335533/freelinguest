'use client'

import Link from 'next/link'
import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { availableGames } from '@/lib/games'

export default function GamesPage() {
  const t = useTranslations('games')

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <div className="glass-card overflow-hidden rounded-2xl">
        <div className="border-fl-border/60 flex items-center gap-2 border-b px-6 py-4">
          <span aria-hidden="true" className="text-fl-label text-fl-accent font-bold">
            ●
          </span>
          <h1 className="text-fl-label text-fl-muted-2 font-sans font-bold tracking-widest uppercase">
            {t('title')}
          </h1>
        </div>
        <div className="px-6 py-5">
          <p className="text-fl-muted-2 font-sans text-sm leading-relaxed font-medium">
            {t('description')}
          </p>
        </div>
      </div>

      {availableGames.length === 0 ? (
        <section
          aria-labelledby="games-empty-title"
          className="glass-card space-y-4 rounded-2xl px-6 py-10 text-center"
        >
          <h2
            id="games-empty-title"
            className="text-fl-fg font-sans text-base font-semibold"
          >
            {t('emptyTitle')}
          </h2>
          <p className="text-fl-muted-2 mx-auto max-w-lg font-sans text-sm leading-relaxed">
            {t('emptyDescription')}
          </p>
          <Link
            href="/plan"
            className="neu-button text-fl-label text-fl-fg inline-block rounded-xl px-5 py-2.5 font-sans font-bold tracking-widest uppercase"
          >
            {t('goToPlan')}
          </Link>
        </section>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {availableGames.map((game) => (
            <Link
              key={game.id}
              href={game.href}
              className="neu-card group block overflow-hidden rounded-2xl"
            >
              <div className="relative aspect-video w-full overflow-hidden">
                <Image
                  src={`/game/${game.id}.jpeg`}
                  alt=""
                  fill
                  sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                  className="object-cover transition-transform duration-300 group-hover:scale-105"
                />
              </div>
              <div className="space-y-2 p-4">
                <h2 className="text-fl-fg group-hover:text-fl-fg-bright font-sans text-sm font-semibold transition-colors">
                  {t(game.titleKey)}
                </h2>
                <p className="text-fl-muted-2 font-sans text-sm leading-relaxed">
                  {t(game.descriptionKey)}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
