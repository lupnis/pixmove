import { ref } from 'vue'
import { fallbackLocale, messages } from './messages'

const locale = ref(fallbackLocale)

const getByPath = (obj, path) => {
  if (!obj || !path) return undefined
  const parts = String(path).split('.')
  let current = obj

  for (const part of parts) {
    if (current == null || typeof current !== 'object' || !(part in current)) {
      return undefined
    }
    current = current[part]
  }

  return current
}

const formatMessage = (template, vars = {}) => {
  if (typeof template !== 'string') return template

  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (!(key in vars)) return `{${key}}`
    const value = vars[key]
    return value == null ? '' : String(value)
  })
}

export const setLocale = (nextLocale) => {
  const candidate = String(nextLocale || '').trim()
  locale.value = messages[candidate] ? candidate : fallbackLocale
}

export const translate = (key, vars) => {
  const activeMessages = messages[locale.value] || messages[fallbackLocale] || {}
  const fallbackMessages = messages[fallbackLocale] || {}

  const message = getByPath(activeMessages, key) ?? getByPath(fallbackMessages, key)

  if (typeof message === 'undefined') {
    return key
  }

  return formatMessage(message, vars)
}

export const useI18n = () => ({
  locale,
  setLocale,
  t: translate,
})
