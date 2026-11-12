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

export function isSupportedLocale(value: string | null | undefined): value is Locale {
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
