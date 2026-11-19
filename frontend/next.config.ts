import createNextIntlPlugin from 'next-intl/plugin'
import type { NextConfig } from 'next'
import path from 'node:path'

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

const allowedDevOrigins = [
  // Automatically allow any Cloudflare Tunnel subdomain in dev so
  // HMR WebSocket connections from trycloudflare.com work without
  // having to update env vars every time the tunnel restarts.
  ...(process.env.NODE_ENV !== 'production'
    ? ['*.trycloudflare.com', '*.ngrok.io', '*.ngrok-free.app']
    : []),
  // User-configured additional origins (e.g. a named tunnel, a VM IP)
  ...(process.env.NEXT_PUBLIC_DEV_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .flatMap((origin) => {
      try {
        const url = new URL(origin)
        return [origin, url.hostname]
      } catch {
        // Not a full URL — pass through as-is so wildcards like
        // "*.example.com" reach Next.js glob matching directly.
        return [origin]
      }
    }),
]

const nextConfig: NextConfig = {
  poweredByHeader: false,
  output: 'standalone',
  allowedDevOrigins,
  // src/i18n/request.ts imports translations from the repo-root messages/
  // folder, which lies outside frontend/. Widen Turbopack's root so it can resolve them.
  turbopack: {
    root: path.resolve(__dirname, '..'),
  },
  experimental: {
    // The /api rewrite proxy aborts after 30s by default and returns a 500.
    // First-time lesson generation on a local LLM (e.g. /api/study-plan/today)
    // routinely takes 60s+, so give proxied backend calls up to 10 minutes.
    proxyTimeout: 600_000,
  },
  typescript: {
    tsconfigPath: 'tsconfig.build.json',
  },
  webpack(config, { isServer }) {
    if (isServer) {
      // Prevent SSR bundling of WASM-heavy packages; ConversationMode is
      // always loaded with dynamic({ ssr: false }) but this guards against
      // accidental server-side imports.
      const externals = Array.isArray(config.externals) ? config.externals : []
      config.externals = [
        ...externals,
        '@ricky0123/vad-react',
        '@ricky0123/vad-web',
        'onnxruntime-web',
      ]
    }

    // Suppress benign "Critical dependency: require function used dynamically"
    // warnings from onnxruntime-web's CJS bundles (used by @ricky0123/vad-web).
    // These warnings are harmless: the modules work correctly at runtime because
    // ConversationMode is always loaded with dynamic({ ssr: false }), and the
    // dynamic require() calls inside ort.min.js / ort.wasm.min.js only resolve
    // optional WASM backends — they will never execute on the server.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      (warning: { message?: string; module?: { resource?: string } }) => {
        const resource = warning?.module?.resource ?? ''
        return (
          /Critical dependency/.test(warning?.message ?? '') &&
          /onnxruntime-web/.test(resource)
        )
      },
    ]

    return config
  },
  async headers() {
    const headers: Array<{ key: string; value: string }> = [
      { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
      // Required for SharedArrayBuffer (onnxruntime-web threaded WASM).
      // credentialless COEP is more permissive than require-corp and works
      // with client-side navigation in Next.js (headers must be global).
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
    ]

    if (process.env.NODE_ENV === 'production') {
      headers.push({
        key: 'Content-Security-Policy',
        value: [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
          "style-src 'self' 'unsafe-inline'",
          "connect-src 'self' ws: wss:",
          "img-src 'self' data: blob:",
          "media-src 'self' blob:",
          "worker-src 'self' blob:",
          "font-src 'self'",
          "object-src 'none'",
          "base-uri 'self'",
        ].join('; '),
      })
    }

    return [
      {
        source: '/(.*)',
        headers,
      },
    ]
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.BACKEND_URL || 'http://backend:8000'}/api/:path*`,
      },
      {
        // Same-origin WebSocket proxy for /ws/conversation. Next.js forwards
        // the upgrade request to the backend, so the voice conversation works
        // when only the frontend is exposed (Cloudflare/ngrok tunnel, LAN IP)
        // and NEXT_PUBLIC_API_URL is left empty.
        source: '/ws/:path*',
        destination: `${process.env.BACKEND_URL || 'http://backend:8000'}/ws/:path*`,
      },
    ]
  },
}

export default withNextIntl(nextConfig)
