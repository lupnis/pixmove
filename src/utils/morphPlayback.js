export const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export const smoothstep = (t) => {
  const value = clamp(t, 0, 1)
  return value * value * (3 - 2 * value)
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

  let sampleProgress = p

  if (p <= 0) {
    out.x = grid.sourcePositions?.[base2] ?? 0
    out.y = grid.sourcePositions?.[base2 + 1] ?? 0
    return out
  }

  if (p >= 1 && allowFinalTarget) {
    out.x = grid.targetPositions?.[base2] ?? 0
    out.y = grid.targetPositions?.[base2 + 1] ?? 0
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
  x += (grid.targetPositions[base2] - x) * settle
  y += (grid.targetPositions[base2 + 1] - y) * settle

  out.x = x
  out.y = y
  return out
}
