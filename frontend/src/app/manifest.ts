import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Linguist',
    short_name: 'Linguist',
    description: 'AI-powered language learning platform',
    start_url: '/',
    display: 'standalone',
    background_color: '#090d16',
    theme_color: '#2563eb',
    icons: [
      { src: '/linguist-mark.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  }
}
