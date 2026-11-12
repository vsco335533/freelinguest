import { getRequestConfig } from 'next-intl/server'
import { cookies, headers } from 'next/headers'
import { SUPPORTED_LOCALES, type Locale } from '@/lib/locales'

function resolveLocale(raw: string | undefined): Locale {
  if (raw && (SUPPORTED_LOCALES as readonly string[]).includes(raw)) {
    return raw as Locale
  }
  return 'en'
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(override)) {
    const val = override[key]
    const baseVal = result[key]
    if (
      val &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      baseVal &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        val as Record<string, unknown>
      )
    } else if (val !== undefined) {
      result[key] = val
    }
  }
  return result
}

export default getRequestConfig(async () => {
  const headerStore = await headers()
  const cookieStore = await cookies()

  // x-next-locale is injected by the middleware on every request (including the
  // very first one, before the NEXT_LOCALE cookie has been written to the client)
  const locale = resolveLocale(
    headerStore.get('x-next-locale') ?? cookieStore.get('NEXT_LOCALE')?.value
  )

  const defaultMessages = (await import('../../messages/en.json')).default
  let messages = defaultMessages

  if (locale !== 'en') {
    try {
      const localeMessages = (await import(`../../messages/${locale}.json`))
        .default
      messages = deepMerge(defaultMessages, localeMessages)
    } catch {
      messages = defaultMessages
    }
  }

  return {
    locale,
    messages,
  }
})
