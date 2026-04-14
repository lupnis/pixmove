import YAML from 'yaml'
import uiSettingsRaw from './ui-settings.yaml?raw'

const FALLBACK_THEME_MODES = [
  {
    value: 'light',
    label: '亮色',
    i18n: {
      'zh-CN': '亮色',
      'zh-TW': '亮色',
      en: 'Light',
      fr: 'Clair',
    },
  },
  {
    value: 'dark',
    label: '暗色',
    i18n: {
      'zh-CN': '暗色',
      'zh-TW': '暗色',
      en: 'Dark',
      fr: 'Sombre',
    },
  },
  {
    value: 'system',
    label: '跟随系统',
    i18n: {
      'zh-CN': '跟随系统',
      'zh-TW': '跟随系统',
      en: 'Follow System',
      fr: 'Suivre le systeme',
    },
  },
]

const FALLBACK_LANGUAGE_MODES = [
  { value: 'browser', label: 'Follow Browser' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'Francais' },
]

const FALLBACK_TONES = [
  {
    value: 'blue',
    label: '湖蓝',
    i18n: {
      'zh-CN': '湖蓝',
      'zh-TW': '湖藍',
      en: 'Lake Blue',
      fr: 'Bleu lac',
    },
    dot: '#3b82f6',
    palette: {
      accent: '#3b82f6',
      accentStrong: '#265ec3',
      accentSoft: 'rgba(59, 130, 246, 0.16)',
      accentBorder: 'rgba(59, 130, 246, 0.45)',
      scrollbarTrack: 'rgba(59, 130, 246, 0.34)',
      scrollbarThumb: 'rgba(59, 130, 246, 0.76)',
      scrollbarThumbHover: '#265ec3',
    },
  },
]

const FALLBACK_CONFIG = {
  appearance: {
    defaultThemeMode: 'system',
    defaultComponentTone: 'blue',
    defaultLanguageMode: 'browser',
    themeModes: FALLBACK_THEME_MODES,
    languageModes: FALLBACK_LANGUAGE_MODES,
    componentTones: FALLBACK_TONES,
  },
}

const toCleanString = (value, fallback = '') => {
  if (typeof value !== 'string') return fallback
  const next = value.trim()
  return next || fallback
}

const normalizeLabelI18n = (value) => {
  if (!value || typeof value !== 'object') return {}

  const normalized = {}

  for (const [locale, label] of Object.entries(value)) {
    const localeKey = toCleanString(locale)
    const localeLabel = toCleanString(label)

    if (!localeKey || !localeLabel) continue
    normalized[localeKey] = localeLabel
  }

  return normalized
}

const normalizeThemeModes = (modes) => {
  const source = Array.isArray(modes) ? modes : []
  const dedup = new Set()
  const normalized = []

  for (const item of source) {
    const value = toCleanString(item?.value)
    if (!value || dedup.has(value)) continue

    dedup.add(value)
    normalized.push({
      value,
      label: toCleanString(item?.label, value),
      i18n: normalizeLabelI18n(item?.i18n),
    })
  }

  return normalized.length > 0 ? normalized : FALLBACK_THEME_MODES
}

const normalizeLanguageModes = (modes) => {
  const source = Array.isArray(modes) ? modes : []
  const dedup = new Set()
  const normalized = []

  for (const item of source) {
    const value = toCleanString(item?.value)
    if (!value || dedup.has(value)) continue

    dedup.add(value)
    normalized.push({
      value,
      label: toCleanString(item?.label, value),
    })
  }

  if (!normalized.some((item) => item.value === 'browser')) {
    normalized.unshift(FALLBACK_LANGUAGE_MODES[0])
  }

  return normalized.length > 0 ? normalized : FALLBACK_LANGUAGE_MODES
}

const normalizeTonePalette = (palette, accent) => {
  const fallbackAccent = toCleanString(accent, FALLBACK_TONES[0].palette.accent)
  const fallbackStrong = `color-mix(in srgb, ${fallbackAccent} 78%, black)`

  return {
    accent: toCleanString(palette?.accent, fallbackAccent),
    accentStrong: toCleanString(palette?.accentStrong, fallbackStrong),
    accentSoft: toCleanString(palette?.accentSoft, `color-mix(in srgb, ${fallbackAccent} 16%, transparent)`),
    accentBorder: toCleanString(palette?.accentBorder, `color-mix(in srgb, ${fallbackAccent} 45%, transparent)`),
    scrollbarTrack: toCleanString(palette?.scrollbarTrack, `color-mix(in srgb, ${fallbackAccent} 40%, transparent)`),
    scrollbarThumb: toCleanString(palette?.scrollbarThumb, `color-mix(in srgb, ${fallbackAccent} 88%, transparent)`),
    scrollbarThumbHover: toCleanString(palette?.scrollbarThumbHover, toCleanString(palette?.accentStrong, fallbackStrong)),
  }
}

const normalizeComponentTones = (tones) => {
  const source = Array.isArray(tones) ? tones : []
  const dedup = new Set()
  const normalized = []

  for (const item of source) {
    const value = toCleanString(item?.value)
    if (!value || dedup.has(value)) continue

    dedup.add(value)

    const dot = toCleanString(item?.dot, FALLBACK_TONES[0].dot)
    normalized.push({
      value,
      label: toCleanString(item?.label, value),
      i18n: normalizeLabelI18n(item?.i18n),
      dot,
      palette: normalizeTonePalette(item?.palette, dot),
    })
  }

  return normalized.length > 0 ? normalized : FALLBACK_TONES
}

const parseYamlConfig = () => {
  try {
    const parsed = YAML.parse(uiSettingsRaw)
    if (parsed && typeof parsed === 'object') {
      return parsed
    }
  } catch {
    // Keep fallback config when YAML is malformed.
  }

  return FALLBACK_CONFIG
}

const parsedConfig = parseYamlConfig()
const appearance = parsedConfig?.appearance && typeof parsedConfig.appearance === 'object'
  ? parsedConfig.appearance
  : FALLBACK_CONFIG.appearance

export const APPEARANCE_CONFIG = appearance

export const THEME_MODE_OPTIONS = normalizeThemeModes(appearance.themeModes)
export const THEME_MODES = THEME_MODE_OPTIONS.map((item) => item.value)

export const LANGUAGE_MODE_OPTIONS = normalizeLanguageModes(appearance.languageModes)
export const LANGUAGE_MODES = LANGUAGE_MODE_OPTIONS.map((item) => item.value)

export const COMPONENT_TONE_OPTIONS = normalizeComponentTones(appearance.componentTones)
export const COMPONENT_TONES = COMPONENT_TONE_OPTIONS.map((item) => item.value)

export const DEFAULT_THEME_MODE = THEME_MODES.includes(appearance.defaultThemeMode)
  ? appearance.defaultThemeMode
  : THEME_MODES.includes('system')
    ? 'system'
    : THEME_MODES[0]

export const DEFAULT_LANGUAGE_MODE = LANGUAGE_MODES.includes(appearance.defaultLanguageMode)
  ? appearance.defaultLanguageMode
  : LANGUAGE_MODES.includes('browser')
    ? 'browser'
    : LANGUAGE_MODES[0]

export const DEFAULT_COMPONENT_TONE = COMPONENT_TONES.includes(appearance.defaultComponentTone)
  ? appearance.defaultComponentTone
  : COMPONENT_TONES[0]

const tonePaletteMap = Object.fromEntries(
  COMPONENT_TONE_OPTIONS.map((tone) => [tone.value, tone.palette]),
)

export const normalizeThemeMode = (mode) =>
  THEME_MODES.includes(mode) ? mode : DEFAULT_THEME_MODE

export const normalizeLanguageMode = (mode) =>
  LANGUAGE_MODES.includes(mode) ? mode : DEFAULT_LANGUAGE_MODE

const explicitLanguages = LANGUAGE_MODES.filter((mode) => mode !== 'browser')

const explicitLanguageMap = Object.fromEntries(
  explicitLanguages.map((mode) => [mode.toLowerCase(), mode]),
)

const fallbackExplicitLanguage = explicitLanguages.includes('en')
  ? 'en'
  : explicitLanguages[0] || 'en'

const mapBrowserLanguage = (rawLanguage) => {
  const normalized = toCleanString(rawLanguage).replace('_', '-').toLowerCase()
  if (!normalized) return null

  const exact = explicitLanguageMap[normalized]
  if (exact) return exact

  if (normalized.startsWith('zh')) {
    const isTraditional = normalized.includes('hant')
      || normalized.includes('-tw')
      || normalized.includes('-hk')
      || normalized.includes('-mo')

    if (isTraditional && explicitLanguages.includes('zh-TW')) {
      return 'zh-TW'
    }

    if (explicitLanguages.includes('zh-CN')) {
      return 'zh-CN'
    }
  }

  const [base] = normalized.split('-')
  if (!base) return null

  for (const candidate of explicitLanguages) {
    if (candidate.toLowerCase() === base) return candidate
  }

  return null
}

export const resolveAppliedLanguage = (mode, browserLanguages = []) => {
  const normalizedMode = normalizeLanguageMode(mode)

  if (normalizedMode !== 'browser') {
    const mapped = mapBrowserLanguage(normalizedMode)
    return mapped || fallbackExplicitLanguage
  }

  const source = Array.isArray(browserLanguages) ? browserLanguages : []

  for (const candidate of source) {
    const mapped = mapBrowserLanguage(candidate)
    if (mapped) return mapped
  }

  return fallbackExplicitLanguage
}

export const resolveOptionLabel = (option, locale) => {
  const fallback = toCleanString(option?.label, toCleanString(option?.value, ''))
  const i18n = option?.i18n && typeof option.i18n === 'object' ? option.i18n : {}

  const localeKey = toCleanString(locale).replace('_', '-')
  if (!localeKey) return fallback

  if (i18n[localeKey]) return i18n[localeKey]

  const lowerMap = Object.fromEntries(
    Object.entries(i18n).map(([key, value]) => [key.toLowerCase(), value]),
  )

  const lowerLocale = localeKey.toLowerCase()
  if (lowerMap[lowerLocale]) return lowerMap[lowerLocale]

  const [baseLanguage] = lowerLocale.split('-')
  if (baseLanguage && lowerMap[baseLanguage]) return lowerMap[baseLanguage]

  return fallback
}

export const normalizeComponentTone = (tone) =>
  COMPONENT_TONES.includes(tone) ? tone : DEFAULT_COMPONENT_TONE

export const getTonePalette = (tone) =>
  tonePaletteMap[normalizeComponentTone(tone)] || tonePaletteMap[DEFAULT_COMPONENT_TONE]

export const applyComponentTonePalette = (tone, targetElement = null) => {
  const target = targetElement || (typeof document !== 'undefined' ? document.documentElement : null)
  if (!target) return

  const palette = getTonePalette(tone)
  if (!palette) return

  target.style.setProperty('--accent', palette.accent)
  target.style.setProperty('--accent-strong', palette.accentStrong)
  target.style.setProperty('--accent-soft', palette.accentSoft)
  target.style.setProperty('--accent-border', palette.accentBorder)
  target.style.setProperty('--scrollbar-track', palette.scrollbarTrack)
  target.style.setProperty('--scrollbar-thumb', palette.scrollbarThumb)
  target.style.setProperty('--scrollbar-thumb-hover', palette.scrollbarThumbHover)
}
