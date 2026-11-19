import { SUPPORTED_LOCALES, type Locale } from './locales'

export const ORDERED_BASE_LOCALES: readonly Locale[] = [
  'en',
  'hi',
  'te',
  'ta',
  'ml',
  'or',
  'kn',
  'es',
  'fr',
  'pt',
  'de',
  'it',
  'pl',
  'nl',
  'ro',
  'ru',
  'tr',
  'sv',
  'da',
  'fi',
  'hr',
]

export const BASE_LOCALE_FLAGS: Partial<Record<string, string>> = {
  en: '/flags/uk.jpg',
  hi: '/flags/india.svg',
  te: '/flags/india.svg',
  ta: '/flags/india.svg',
  ml: '/flags/india.svg',
  or: '/flags/india.svg',
  kn: '/flags/india.svg',
  es: '/flags/spain.jpg',
  fr: '/flags/france.jpg',
  de: '/flags/germany.jpg',
  it: '/flags/italy.jpg',
  pt: '/flags/portugal.jpg',
  pl: '/flags/poland.jpg',
  nl: '/flags/netherlands.jpg',
  ru: '/flags/russia.jpg',
  sv: '/flags/sweden.jpg',
}

/** Region-specific flags for codes like "en-US" that users may have stored. */
const REGIONAL_BASE_FLAGS: Partial<Record<string, string>> = {
  'en-US': '/flags/usa.jpg',
  'en-GB': '/flags/uk.jpg',
  'pt-BR': '/flags/brazil.jpg',
  'pt-PT': '/flags/portugal.jpg',
  'zh-CN': '/flags/china.jpg',
  'ja-JP': '/flags/japan.jpg',
  'ko-KR': '/flags/south_korea.jpg',
}

/** Resolve a flag for a base-language code, accepting "en" or "en-US" forms. */
export function getBaseLocaleFlag(
  code: string | null | undefined
): string | undefined {
  if (!code) return undefined
  return (
    REGIONAL_BASE_FLAGS[code] ??
    BASE_LOCALE_FLAGS[code] ??
    BASE_LOCALE_FLAGS[code.split('-')[0].toLowerCase()]
  )
}

/** "en-US" -> "en"; used to match a stored regional code to a base locale. */
export function baseLocaleRoot(code: string | null | undefined): string {
  return (code ?? '').split('-')[0].toLowerCase()
}

export function isSupportedLocale(
  value: string | null | undefined
): value is Locale {
  return !!value && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

/** Persist the selected base/UI locale into cookies so SSR picks it up. */
export function persistLocaleCookies(locale: string): void {
  if (typeof document === 'undefined' || !isSupportedLocale(locale)) return
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  const opts = `path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax${secure}`
  document.cookie = `NEXT_LOCALE=${locale}; ${opts}`
  document.cookie = `LOCALE_DETECTED=1; ${opts}`
}
