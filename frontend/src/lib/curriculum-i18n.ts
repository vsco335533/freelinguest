const INDIC_LOCALE_SET = new Set(['hi', 'te', 'ta', 'ml', 'or', 'kn'])

const EN_TITLE_TO_UNIT_ID: Record<string, string> = {
  'identity & greetings': 'a1-unit-1',
  'my world': 'a1-unit-2',
  'daily life': 'a1-unit-3',
  'places & location': 'a1-unit-4',
  'actions right now': 'a1-unit-5',
  yesterday: 'a1-unit-6',
  'abilities & wishes': 'a1-unit-7',
  'a1 consolidation': 'a1-unit-8',
  'irregular verbs & past narratives': 'a2-unit-1',
  'plans & future': 'a2-unit-2',
  comparisons: 'a2-unit-3',
  'ability & permission': 'a2-unit-4',
  'quantity & shopping': 'a2-unit-5',
  'health & body': 'a2-unit-6',
  'travel & transport': 'a2-unit-7',
  'a2 consolidation': 'a2-unit-8',
  'present perfect aspects': 'b1-unit-1',
  'zero, first & second conditionals': 'b1-unit-2',
  'passive voice': 'b1-unit-3',
  'relative clauses, connectors & phrasal verbs': 'b1-unit-4',
  'modals, advice & question tags': 'b1-unit-5',
  'reported speech': 'b1-unit-6',
  'past perfect, wishes & regrets': 'b1-unit-7',
  'b1 consolidation': 'b1-unit-8',
  'past narratives & sequencing': 'b2-unit-1',
  'advanced wishes: wish + would/could': 'b2-unit-2',
  'conditionals 2 & 3': 'b2-unit-3',
  'causative have/get, modal passive & passive infinitives': 'b2-unit-4',
  'gerunds, infinitives & phrasal verbs': 'b2-unit-5',
  'reported speech & modal perfects': 'b2-unit-6',
  'concession, contrast & academic discourse': 'b2-unit-7',
  'b2 consolidation': 'b2-unit-8',
  'mixed conditionals & speculation': 'c1-unit-1',
  'participle clauses': 'c1-unit-2',
  'hedging & formal register': 'c1-unit-3',
  'emphasis: inversion & cleft sentences': 'c1-unit-4',
  'ellipsis, substitution & textual cohesion': 'c1-unit-5',
  'advanced relative clauses, critical thinking & phrasal verbs': 'c1-unit-6',
  'argumentation & rhetoric': 'c1-unit-7',
  'c1 consolidation': 'c1-unit-8',
  'discourse markers & text cohesion': 'c2-unit-1',
  'nominalisation & academic style': 'c2-unit-2',
  'idiomatic & figurative language': 'c2-unit-3',
  'fronting, emphasis & stylistic devices': 'c2-unit-4',
  'critical reading & academic writing': 'c2-unit-5',
  'british pragmatics & spoken style': 'c2-unit-6',
  'rhetorical devices & advanced text structure': 'c2-unit-7',
  'c2 consolidation': 'c2-unit-8',
}

const COMPLETION_TEST_RE =
  /Completion Test|Examen de nivel|Test de niveau|Niveautest|Avslutande prov|Итоговый тест|Test di livello|Test poziomu|Avaliação de nível|Exame de nível|Eindtoets|レベル修了テスト|레벨 완료 테스트|等级完成测试/i

const LESSON_SUFFIX_RE =
  /^(.*?)\s*[-–—]\s*(?:Lesson|Lección|Leçon|Lição|Lektion|Lezione|Lekcja|Les|Урок|レッスン|레슨)\s+(\d+)$/i
const ZH_LESSON_SUFFIX_RE = /^(.*?)\s*[-–—]\s*第\s*(\d+)\s*课$/

export interface CommonTranslatorLike {
  (key: string, values?: Record<string, string | number>): string
  has?: (key: string) => boolean
}

export function isIndicLocale(locale: string | undefined | null): boolean {
  return !!locale && INDIC_LOCALE_SET.has(locale)
}

function isEnglishTarget(targetLanguage?: string | null): boolean {
  return !targetLanguage || targetLanguage.startsWith('en')
}

function resolveEnglishUnitId(
  unitId?: string | null,
  title?: string | null,
  targetLanguage?: string | null
): string | null {
  if (title) {
    const byTitle = EN_TITLE_TO_UNIT_ID[title.trim().toLowerCase()]
    if (byTitle) return byTitle
  }
  if (unitId && isEnglishTarget(targetLanguage) && /^[abc][12]-unit-[1-8]$/.test(unitId)) {
    return unitId
  }
  return null
}

function extractCefrLevel(cefrLevel?: string | null, title?: string | null): string {
  if (cefrLevel) return cefrLevel
  const match = title?.match(/\b(A1|A2|B1|B2|C1|C2)\b/i)
  return match ? match[1].toUpperCase() : ''
}

/** Localize a curriculum unit title into the active base language when known. */
export function localizeUnitTitle(
  params: {
    unitId?: string | null
    title?: string | null
    cefrLevel?: string | null
    targetLanguage?: string | null
  },
  tCommon: CommonTranslatorLike
): string {
  const { unitId, title, cefrLevel, targetLanguage } = params
  if (
    unitId === 'completion-test' ||
    unitId === 'level-test' ||
    (title && COMPLETION_TEST_RE.test(title))
  ) {
    const level = extractCefrLevel(cefrLevel, title)
    return tCommon('completionTestTitle', { level })
  }

  const resolvedUnitId = resolveEnglishUnitId(unitId, title, targetLanguage)
  if (resolvedUnitId) {
    const key = `unitTitles.${resolvedUnitId}`
    if (!tCommon.has || tCommon.has(key)) {
      return tCommon(key)
    }
  }
  return title ?? ''
}

/** Localize a lesson title (`{unit} - Lesson {n}` or completion test) into the base language. */
export function localizeLessonTitle(
  params: {
    title?: string | null
    unitId?: string | null
    lessonType?: string | null
    cefrLevel?: string | null
    targetLanguage?: string | null
  },
  tCommon: CommonTranslatorLike
): string {
  const { title, unitId, lessonType, cefrLevel, targetLanguage } = params
  if (
    lessonType === 'level_test' ||
    unitId === 'completion-test' ||
    unitId === 'level-test' ||
    (title && COMPLETION_TEST_RE.test(title))
  ) {
    const level = extractCefrLevel(cefrLevel, title)
    return tCommon('completionTestTitle', { level })
  }

  if (!title) return ''
  const match = title.match(LESSON_SUFFIX_RE) ?? title.match(ZH_LESSON_SUFFIX_RE)
  if (match) {
    const baseTitle = localizeUnitTitle(
      { unitId, title: match[1].trim(), cefrLevel, targetLanguage },
      tCommon
    )
    return tCommon('lessonTitlePattern', {
      title: baseTitle,
      n: Number(match[2]),
    })
  }

  return localizeUnitTitle({ unitId, title, cefrLevel, targetLanguage }, tCommon)
}

/** Localize a curriculum unit competency checklist item when English-based or known. */
export function localizeChecklistItem(
  params: {
    unitId?: string | null
    index: number
    text: string
    targetLanguage?: string | null
  },
  tCommon: CommonTranslatorLike
): string {
  const { unitId, index, text, targetLanguage } = params
  if (unitId && isEnglishTarget(targetLanguage)) {
    const key = `unitChecklists.${unitId}.${index}`
    if (tCommon.has?.(key)) {
      return tCommon(key)
    }
  }
  return text
}

