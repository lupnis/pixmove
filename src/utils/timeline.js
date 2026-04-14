import { clamp, uid } from './format'

export const easingOptions = [
  'linear',
  'inOutSine',
  'inOutQuad',
  'inOutCubic',
  'inOutBack',
  'outExpo',
]

const easeLinear = (t) => t
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2
const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2)
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2)
const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t))
const easeInOutBack = (t) => {
  const c1 = 1.70158
  const c2 = c1 * 1.525

  if (t < 0.5) {
    const p = 2 * t
    return (p * p * ((c2 + 1) * p - c2)) / 2
  }

  const p = 2 * t - 2
  return (p * p * ((c2 + 1) * p + c2) + 2) / 2
}

const easingMap = {
  linear: easeLinear,
  inOutSine: easeInOutSine,
  inOutQuad: easeInOutQuad,
  inOutCubic: easeInOutCubic,
  outExpo: easeOutExpo,
  inOutBack: easeInOutBack,
}

const toFinite = (value, fallback = 0) => {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

export const makeDefaultKeyframes = () => [
  { id: uid(), time: 0, value: 0, easeToNext: 'inOutSine', locked: true },
  { id: uid(), time: 1, value: 1, easeToNext: 'linear', locked: true },
]

const normalizeSingle = (frame, index, total) => {
  const isEdge = index === 0 || index === total - 1
  return {
    id: frame.id || uid(),
    time: clamp(toFinite(frame.time, isEdge ? index : 0), 0, 1),
    value: clamp(toFinite(frame.value, isEdge ? index : 0), 0, 1),
    easeToNext: easingMap[frame.easeToNext] ? frame.easeToNext : 'inOutSine',
    locked: Boolean(frame.locked) || isEdge,
  }
}

export const normalizeKeyframes = (frames) => {
  if (!Array.isArray(frames) || frames.length < 2) {
    return makeDefaultKeyframes()
  }

  const normalized = frames.map((frame, index) => normalizeSingle(frame, index, frames.length))

  normalized.sort((left, right) => left.time - right.time)

  normalized[0].time = 0
  normalized[0].value = 0
  normalized[0].locked = true
  normalized[normalized.length - 1].time = 1
  normalized[normalized.length - 1].value = 1
  normalized[normalized.length - 1].locked = true

  for (let i = 1; i < normalized.length - 1; i += 1) {
    const prev = normalized[i - 1]
    const current = normalized[i]
    const next = normalized[i + 1]

    const minTime = prev.time + 0.005
    const maxTime = next.time - 0.005

    current.time = clamp(current.time, minTime, maxTime)
  }

  return normalized
}

export const evaluateTimeline = (frames, t) => {
  const keyframes = normalizeKeyframes(frames)
  const time = clamp(t, 0, 1)

  if (time <= keyframes[0].time) return keyframes[0].value

  for (let i = 0; i < keyframes.length - 1; i += 1) {
    const start = keyframes[i]
    const end = keyframes[i + 1]

    if (time <= end.time) {
      const segmentDuration = Math.max(0.00001, end.time - start.time)
      const localT = clamp((time - start.time) / segmentDuration, 0, 1)
      const easeFn = easingMap[start.easeToNext] || easeLinear
      const easedT = easeFn(localT)
      return start.value + (end.value - start.value) * easedT
    }
  }

  return keyframes[keyframes.length - 1].value
}

export const addKeyframeAt = (frames, time, value) => {
  const next = [
    ...normalizeKeyframes(frames).map((item) => ({ ...item })),
    {
      id: uid(),
      time: clamp(time, 0, 1),
      value: clamp(value, 0, 1),
      easeToNext: 'inOutSine',
      locked: false,
    },
  ]

  return normalizeKeyframes(next)
}

export const removeKeyframeById = (frames, id) => {
  const next = normalizeKeyframes(frames).filter((frame) => frame.id !== id || frame.locked)
  return normalizeKeyframes(next)
}
