export const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export const smoothstep = (t) => {
  const value = clamp(t, 0, 1)
  return value * value * (3 - 2 * value)
}

const resolveTailSeedDirection = (sourceIndex) => {
  const seed = (Math.imul((sourceIndex + 1) ^ 0x9e3779b9, 2654435761) >>> 0)
  const angle = (seed % 6283) / 1000
  return {
    x: Math.cos(angle),
    y: Math.sin(angle),
  }
}

export const sampleCellPosition = (grid, sourceIndex, progress, out = { x: 0, y: 0 }, options = {}) => {
  if (!grid || !grid.motionPath || grid.count <= 0) {
    out.x = 0
    out.y = 0
    return out
  }

  const p = clamp(progress, 0, 1)
  const base2 = sourceIndex * 2
  const frameCount = Math.max(1, grid.frameCount || 1)
  const allowFinalTarget = options?.allowFinalTarget !== false
  const finalBackoff = clamp(Number(options?.finalBackoff ?? 0.006), 0, 0.1)
  const targetX = grid.targetPositions?.[base2] ?? 0
  const targetY = grid.targetPositions?.[base2 + 1] ?? 0

  let sampleProgress = p

  if (p <= 0) {
    out.x = grid.sourcePositions?.[base2] ?? 0
    out.y = grid.sourcePositions?.[base2 + 1] ?? 0
    return out
  }

  if (p >= 1 && allowFinalTarget) {
    out.x = targetX
    out.y = targetY
    return out
  }

  if (p >= 1 && !allowFinalTarget && frameCount > 1) {
    sampleProgress = 1 - finalBackoff
  }

  const frameProgress = sampleProgress * Math.max(0, frameCount - 1)
  const frameA = Math.floor(frameProgress)
  const frameB = Math.min(frameCount - 1, frameA + 1)
  const localT = frameProgress - frameA

  const indexA = (frameA * grid.count + sourceIndex) * 2
  const indexB = (frameB * grid.count + sourceIndex) * 2

  let x = grid.motionPath[indexA] + (grid.motionPath[indexB] - grid.motionPath[indexA]) * localT
  let y = grid.motionPath[indexA + 1] + (grid.motionPath[indexB + 1] - grid.motionPath[indexA + 1]) * localT

  const settleStrength = clamp(Number(options?.settleStrength ?? 1), 0, 1)
  const settleStart = clamp(Number(options?.settleStart ?? 0.78), 0, 1)
  const settleDuration = clamp(Number(options?.settleDuration ?? (1 - settleStart)), 0.001, 1)
  const settle = smoothstep((sampleProgress - settleStart) / settleDuration) * settleStrength
  x += (targetX - x) * settle
  y += (targetY - y) * settle

  const tailAdjustStrength = clamp(Number(options?.tailAdjustStrength ?? 0.42), 0, 1)
  const tailAdjustStart = clamp(Number(options?.tailAdjustStart ?? 0.9), 0, 1)
  const tailAdjustDuration = clamp(Number(options?.tailAdjustDuration ?? (1 - tailAdjustStart)), 0.001, 1)
  const tailT = clamp((sampleProgress - tailAdjustStart) / tailAdjustDuration, 0, 1)

  if (tailAdjustStrength > 0 && tailT > 0 && sampleProgress < 1) {
    // Enter a short settle window near the end: reach target quickly, then do a subtle damped micro-adjustment.
    const reachBlend = smoothstep(clamp(tailT / 0.32, 0, 1))
    x += (targetX - x) * reachBlend
    y += (targetY - y) * reachBlend

    const probeStep = clamp(Math.max(1 / Math.max(2, frameCount - 1), 0.01), 0.006, 0.06)
    const probeProgress = clamp(sampleProgress - probeStep, 0, 1)
    const probeFrameProgress = probeProgress * Math.max(0, frameCount - 1)
    const probeFrameA = Math.floor(probeFrameProgress)
    const probeFrameB = Math.min(frameCount - 1, probeFrameA + 1)
    const probeLocalT = probeFrameProgress - probeFrameA
    const probeIndexA = (probeFrameA * grid.count + sourceIndex) * 2
    const probeIndexB = (probeFrameB * grid.count + sourceIndex) * 2

    let probeX = grid.motionPath[probeIndexA] + (grid.motionPath[probeIndexB] - grid.motionPath[probeIndexA]) * probeLocalT
    let probeY = grid.motionPath[probeIndexA + 1] + (grid.motionPath[probeIndexB + 1] - grid.motionPath[probeIndexA + 1]) * probeLocalT
    const probeSettle = smoothstep((probeProgress - settleStart) / settleDuration) * settleStrength
    probeX += (targetX - probeX) * probeSettle
    probeY += (targetY - probeY) * probeSettle

    let dirX = targetX - probeX
    let dirY = targetY - probeY
    let dirLength = Math.hypot(dirX, dirY)

    if (!Number.isFinite(dirLength) || dirLength < 0.0001) {
      const seed = resolveTailSeedDirection(sourceIndex)
      dirX = seed.x
      dirY = seed.y
      dirLength = 1
    }

    dirX /= dirLength
    dirY /= dirLength

    const normalX = -dirY
    const normalY = dirX
    const motionScale = clamp(Math.hypot(targetX - probeX, targetY - probeY), 0.06, 0.9)
    const decay = (1 - tailT) ** 1.2
    const primaryWave = Math.sin(tailT * Math.PI * 1.5)
    const secondaryWave = Math.sin(tailT * Math.PI * 2.4 + 0.65)
    const amplitude = motionScale * 0.4 * tailAdjustStrength * decay

    x += dirX * primaryWave * amplitude + normalX * secondaryWave * amplitude * 0.34
    y += dirY * primaryWave * amplitude + normalY * secondaryWave * amplitude * 0.34

    const offsetX = x - targetX
    const offsetY = y - targetY
    const offsetLength = Math.hypot(offsetX, offsetY)
    const maxOffset = (0.32 + 0.22 * (1 - tailT)) * tailAdjustStrength

    if (offsetLength > maxOffset && offsetLength > 0.0001) {
      const ratio = maxOffset / offsetLength
      x = targetX + offsetX * ratio
      y = targetY + offsetY * ratio
    }
  }

  out.x = x
  out.y = y
  return out
}

const clampIndex = (value, maxExclusive) => {
  const parsed = Number.isFinite(Number(value)) ? Number(value) : 0
  return clamp(Math.round(parsed), 0, Math.max(0, maxExclusive - 1))
}

const resolveAxisFirst = (sourceIndex, targetIndex, options) => {
  if (typeof options?.xFirst === 'boolean') return options.xFirst

  // Deterministic split helps create a "flow" look without diagonal movement.
  const hash = (Math.imul(sourceIndex + 1, 73856093) ^ Math.imul(targetIndex + 1, 19349663)) >>> 0
  return (hash & 1) === 0
}

export const sampleGridFlowPosition = (grid, sourceIndex, progress, out = { x: 0, y: 0 }, options = {}) => {
  if (!grid || grid.count <= 0) {
    out.x = 0
    out.y = 0
    return out
  }

  const p = clamp(progress, 0, 1)
  const safeSourceIndex = clampIndex(sourceIndex, grid.count)
  const base2 = safeSourceIndex * 2
  const sourceX = grid.sourcePositions?.[base2] ?? 0
  const sourceY = grid.sourcePositions?.[base2 + 1] ?? 0
  const targetX = grid.targetPositions?.[base2] ?? sourceX
  const targetY = grid.targetPositions?.[base2 + 1] ?? sourceY

  if (p <= 0) {
    out.x = sourceX
    out.y = sourceY
    return out
  }

  if (p >= 1) {
    out.x = targetX
    out.y = targetY
    return out
  }

  const mappedTargetIndex = clampIndex(grid.sourceToTarget?.[safeSourceIndex] ?? safeSourceIndex, grid.count)
  const xFirst = resolveAxisFirst(safeSourceIndex, mappedTargetIndex, options)

  const dx = targetX - sourceX
  const dy = targetY - sourceY
  const absX = Math.abs(dx)
  const absY = Math.abs(dy)

  if (absX < 0.0001 && absY < 0.0001) {
    out.x = targetX
    out.y = targetY
    return out
  }

  const total = Math.max(0.0001, absX + absY)
  const firstSpan = xFirst ? absX : absY
  const split = clamp(firstSpan / total, 0, 1)

  if (split <= 0.0001) {
    out.x = sourceX + dx * p
    out.y = sourceY + dy * p
    return out
  }

  if (split >= 0.9999) {
    out.x = sourceX + dx * p
    out.y = sourceY + dy * p
    return out
  }

  if (xFirst) {
    if (p <= split) {
      const localT = p / split
      out.x = sourceX + dx * localT
      out.y = sourceY
    } else {
      const localT = (p - split) / (1 - split)
      out.x = targetX
      out.y = sourceY + dy * localT
    }
  } else if (p <= split) {
    const localT = p / split
    out.x = sourceX
    out.y = sourceY + dy * localT
  } else {
    const localT = (p - split) / (1 - split)
    out.x = sourceX + dx * localT
    out.y = targetY
  }

  return out
}
