export const formatTimestamp = (value, locale = undefined) => {
  const date = typeof value === 'number' ? new Date(value) : value
  const formatter = new Intl.DateTimeFormat(locale || undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    month: '2-digit',
    day: '2-digit',
  })

  return formatter.format(date)
}

export const uid = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }

  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export const formatSeconds = (seconds) => `${seconds.toFixed(2)}s`
