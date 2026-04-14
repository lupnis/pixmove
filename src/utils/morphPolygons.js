const MIN_ALPHA = 0.16
const DEFAULT_JITTER_RATIO = 0.22
const MIN_JITTER = 0.6

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

const clampIndex = (index, maxExclusive) => {
  const value = Number.isFinite(Number(index)) ? Number(index) : 0
  return clamp(Math.round(value), 0, Math.max(0, maxExclusive - 1))
}

const mixHash = (seed) => {
  let value = seed | 0
  value ^= value >>> 16
  value = Math.imul(value, 0x7feb352d)
  value ^= value >>> 15
  value = Math.imul(value, 0x846ca68b)
  value ^= value >>> 16
  return value >>> 0
}

const randomUnit = (seed) => (mixHash(seed) & 0xffff) / 0xffff

const jitterOffset = (seed, amount) => (randomUnit(seed) * 2 - 1) * amount

const fillJitteredQuadPoints = (bounds, index, phaseSeed, out) => {
  const base4 = index * 4
  const x = bounds?.[base4] ?? 0
  const y = bounds?.[base4 + 1] ?? 0
  const width = Math.max(1, bounds?.[base4 + 2] ?? 1)
  const height = Math.max(1, bounds?.[base4 + 3] ?? 1)
  const x2 = x + width
  const y2 = y + height

  const jitterAmount = Math.max(MIN_JITTER, Math.min(width, height) * DEFAULT_JITTER_RATIO)
  const seed = (index + 1) * 73856093 + (phaseSeed + 1) * 19349663

  const tlx = clamp(x + jitterOffset(seed + 11, jitterAmount), x, x2)
  const tly = clamp(y + jitterOffset(seed + 17, jitterAmount), y, y2)
  const trx = clamp(x2 + jitterOffset(seed + 23, jitterAmount), x, x2)
  const try_ = clamp(y + jitterOffset(seed + 31, jitterAmount), y, y2)
  const brx = clamp(x2 + jitterOffset(seed + 37, jitterAmount), x, x2)
  const bry = clamp(y2 + jitterOffset(seed + 43, jitterAmount), y, y2)
  const blx = clamp(x + jitterOffset(seed + 47, jitterAmount), x, x2)
  const bly = clamp(y2 + jitterOffset(seed + 53, jitterAmount), y, y2)

  out[0] = tlx
  out[1] = tly
  out[2] = trx
  out[3] = try_
  out[4] = brx
  out[5] = bry
  out[6] = blx
  out[7] = bly

  return out
}

const polygonCenter = (points, out = { x: 0, y: 0 }) => {
  out.x = (points[0] + points[2] + points[4] + points[6]) * 0.25
  out.y = (points[1] + points[3] + points[5] + points[7]) * 0.25
  return out
}

export const fillCellPolygonPoints = (polygons, bounds, index, out, phaseSeed = 0) => {
  const base8 = index * 8

  if (polygons && polygons.length >= base8 + 8) {
    for (let i = 0; i < 8; i += 1) {
      out[i] = polygons[base8 + i]
    }

    return out
  }

  return fillJitteredQuadPoints(bounds, index, phaseSeed, out)
}

export const buildMorphShapeBuffers = (grid) => {
  const count = Number(grid?.count) || 0

  if (!count) {
    return {
      count: 0,
      sourceOffsets: new Float32Array(0),
      targetOffsets: new Float32Array(0),
      colors: new Uint32Array(0),
      alphas: new Float32Array(0),
      fillStyles: [],
    }
  }

  const sourceOffsets = new Float32Array(count * 8)
  const targetOffsets = new Float32Array(count * 8)
  const colors = new Uint32Array(count)
  const alphas = new Float32Array(count)
  const fillStyles = new Array(count)

  const sourcePoints = new Float32Array(8)
  const targetPoints = new Float32Array(8)
  const sourceCenterFallback = { x: 0, y: 0 }
  const targetCenterFallback = { x: 0, y: 0 }

  for (let index = 0; index < count; index += 1) {
    const base2 = index * 2
    const base8 = index * 8

    fillCellPolygonPoints(grid.sourcePolygons, grid.cellBounds, index, sourcePoints, 0)

    const mappedTargetIndex = clampIndex(grid.sourceToTarget?.[index] ?? index, count)
    fillCellPolygonPoints(grid.targetPolygons, grid.cellBounds, mappedTargetIndex, targetPoints, 1 + index)

    const sourceCenterX = grid.sourcePositions?.[base2] ?? polygonCenter(sourcePoints, sourceCenterFallback).x
    const sourceCenterY = grid.sourcePositions?.[base2 + 1] ?? polygonCenter(sourcePoints, sourceCenterFallback).y
    const targetCenterX = grid.targetPositions?.[base2] ?? polygonCenter(targetPoints, targetCenterFallback).x
    const targetCenterY = grid.targetPositions?.[base2 + 1] ?? polygonCenter(targetPoints, targetCenterFallback).y

    for (let point = 0; point < 4; point += 1) {
      const pointBase = base8 + point * 2
      const px = point * 2
      const py = px + 1

      sourceOffsets[pointBase] = sourcePoints[px] - sourceCenterX
      sourceOffsets[pointBase + 1] = sourcePoints[py] - sourceCenterY
      targetOffsets[pointBase] = targetPoints[px] - targetCenterX
      targetOffsets[pointBase + 1] = targetPoints[py] - targetCenterY
    }

    const colorBase = index * 4
    const red = grid.sourceColors?.[colorBase] ?? 255
    const green = grid.sourceColors?.[colorBase + 1] ?? 255
    const blue = grid.sourceColors?.[colorBase + 2] ?? 255
    const alpha = clamp((grid.sourceColors?.[colorBase + 3] ?? 255) / 255, MIN_ALPHA, 1)

    colors[index] = (red << 16) | (green << 8) | blue
    alphas[index] = alpha
    fillStyles[index] = `rgba(${red}, ${green}, ${blue}, ${alpha})`
  }

  return {
    count,
    sourceOffsets,
    targetOffsets,
    colors,
    alphas,
    fillStyles,
  }
}

const shapeCache = new WeakMap()

export const getMorphShapeBuffers = (grid) => {
  if (!grid || !grid.count) {
    return {
      count: 0,
      sourceOffsets: new Float32Array(0),
      targetOffsets: new Float32Array(0),
      colors: new Uint32Array(0),
      alphas: new Float32Array(0),
      fillStyles: [],
    }
  }

  if (shapeCache.has(grid)) {
    return shapeCache.get(grid)
  }

  const buffers = buildMorphShapeBuffers(grid)
  shapeCache.set(grid, buffers)
  return buffers
}

export const interpolateCellPolygon = (shapeBuffers, index, centerX, centerY, morphT, out) => {
  const count = shapeBuffers?.count || 0
  if (!count) return out

  const safeIndex = clampIndex(index, count)
  const base = safeIndex * 8
  const t = clamp(Number(morphT) || 0, 0, 1)

  for (let i = 0; i < 8; i += 2) {
    const sourceX = shapeBuffers.sourceOffsets[base + i]
    const sourceY = shapeBuffers.sourceOffsets[base + i + 1]
    const targetX = shapeBuffers.targetOffsets[base + i]
    const targetY = shapeBuffers.targetOffsets[base + i + 1]

    out[i] = centerX + sourceX + (targetX - sourceX) * t
    out[i + 1] = centerY + sourceY + (targetY - sourceY) * t
  }

  return out
}
