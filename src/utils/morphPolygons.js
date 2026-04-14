const MIN_ALPHA = 0.16
const DEFAULT_JITTER_RATIO = 0.34
const MIN_JITTER = 1.2
const VERTEX_EDGE_MARGIN = 0.15

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

const resolveGridSide = (count, sideHint) => {
  const hinted = Number.isFinite(Number(sideHint)) ? Math.round(Number(sideHint)) : 0
  if (hinted > 1) return hinted

  return Math.max(1, Math.round(Math.sqrt(Math.max(1, count))))
}

const buildAxisLines = (bounds, side) => {
  if (!bounds || bounds.length < side * side * 4) {
    return null
  }

  const xLines = new Float32Array(side + 1)
  const yLines = new Float32Array(side + 1)

  for (let gx = 0; gx < side; gx += 1) {
    const base = gx * 4
    const x = bounds[base] ?? 0
    const width = Math.max(1, bounds[base + 2] ?? 1)
    xLines[gx] = x

    if (gx === side - 1) {
      xLines[side] = x + width
    }
  }

  for (let gy = 0; gy < side; gy += 1) {
    const base = gy * side * 4
    const y = bounds[base + 1] ?? 0
    const height = Math.max(1, bounds[base + 3] ?? 1)
    yLines[gy] = y

    if (gy === side - 1) {
      yLines[side] = y + height
    }
  }

  for (let i = 1; i < xLines.length; i += 1) {
    if (!(xLines[i] > xLines[i - 1])) {
      xLines[i] = xLines[i - 1] + 1
    }
  }

  for (let i = 1; i < yLines.length; i += 1) {
    if (!(yLines[i] > yLines[i - 1])) {
      yLines[i] = yLines[i - 1] + 1
    }
  }

  return { xLines, yLines }
}

const buildVertexField = (xLines, yLines, side, phaseSeed) => {
  const stride = side + 1
  const vertices = new Float32Array(stride * stride * 2)

  for (let vy = 0; vy <= side; vy += 1) {
    for (let vx = 0; vx <= side; vx += 1) {
      let x = xLines[vx]
      let y = yLines[vy]

      const isBoundary = vx === 0 || vy === 0 || vx === side || vy === side

      if (!isBoundary) {
        const left = xLines[vx - 1]
        const right = xLines[vx + 1]
        const top = yLines[vy - 1]
        const bottom = yLines[vy + 1]

        const jitterX = Math.max(
          MIN_JITTER,
          Math.min(xLines[vx] - left, right - xLines[vx]) * DEFAULT_JITTER_RATIO,
        )
        const jitterY = Math.max(
          MIN_JITTER,
          Math.min(yLines[vy] - top, bottom - yLines[vy]) * DEFAULT_JITTER_RATIO,
        )

        const seed = Math.imul(vx + 1, 73856093)
          ^ Math.imul(vy + 1, 19349663)
          ^ Math.imul(phaseSeed + 1, 83492791)

        x = clamp(
          x + jitterOffset(seed + 17, jitterX),
          left + VERTEX_EDGE_MARGIN,
          right - VERTEX_EDGE_MARGIN,
        )
        y = clamp(
          y + jitterOffset(seed + 31, jitterY),
          top + VERTEX_EDGE_MARGIN,
          bottom - VERTEX_EDGE_MARGIN,
        )
      }

      const base2 = (vy * stride + vx) * 2
      vertices[base2] = x
      vertices[base2 + 1] = y
    }
  }

  return vertices
}

const buildSharedFallbackPolygons = (bounds, side, phaseSeed) => {
  const lines = buildAxisLines(bounds, side)
  if (!lines) return null

  const { xLines, yLines } = lines
  const vertices = buildVertexField(xLines, yLines, side, phaseSeed)
  const polygons = new Float32Array(side * side * 8)
  const stride = side + 1

  for (let gy = 0; gy < side; gy += 1) {
    for (let gx = 0; gx < side; gx += 1) {
      const index = gy * side + gx
      const base8 = index * 8

      const v00 = (gy * stride + gx) * 2
      const v10 = (gy * stride + gx + 1) * 2
      const v11 = ((gy + 1) * stride + gx + 1) * 2
      const v01 = ((gy + 1) * stride + gx) * 2

      polygons[base8] = vertices[v00]
      polygons[base8 + 1] = vertices[v00 + 1]
      polygons[base8 + 2] = vertices[v10]
      polygons[base8 + 3] = vertices[v10 + 1]
      polygons[base8 + 4] = vertices[v11]
      polygons[base8 + 5] = vertices[v11 + 1]
      polygons[base8 + 6] = vertices[v01]
      polygons[base8 + 7] = vertices[v01 + 1]
    }
  }

  return polygons
}

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
  const side = resolveGridSide(count, grid?.side)
  const hasSourcePolygons = Boolean(grid?.sourcePolygons && grid.sourcePolygons.length >= count * 8)
  const hasTargetPolygons = Boolean(grid?.targetPolygons && grid.targetPolygons.length >= count * 8)
  const sourceFallbackPolygons = hasSourcePolygons
    ? null
    : buildSharedFallbackPolygons(grid?.cellBounds, side, 0)
  const targetFallbackPolygons = hasTargetPolygons
    ? null
    : buildSharedFallbackPolygons(grid?.cellBounds, side, 97)

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

    fillCellPolygonPoints(
      hasSourcePolygons ? grid.sourcePolygons : sourceFallbackPolygons,
      grid.cellBounds,
      index,
      sourcePoints,
      0,
    )

    const mappedTargetIndex = clampIndex(grid.sourceToTarget?.[index] ?? index, count)
    fillCellPolygonPoints(
      hasTargetPolygons ? grid.targetPolygons : targetFallbackPolygons,
      grid.cellBounds,
      mappedTargetIndex,
      targetPoints,
      1 + index,
    )

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
