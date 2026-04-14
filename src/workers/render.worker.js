import { Delaunay } from 'd3-delaunay'

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const smoothstep = (t) => {
  const value = clamp(t, 0, 1)
  return value * value * (3 - 2 * value)
}
const VORONOI_SETTLE_START = 0.9
const VORONOI_SETTLE_DURATION = 0.1
const VORONOI_SETTLE_STRENGTH = 0
const VORONOI_FINAL_BACKOFF = 0
const VORONOI_TAIL_ADJUST_START = 0.9
const VORONOI_TAIL_ADJUST_DURATION = 0.1
const VORONOI_TAIL_ADJUST_STRENGTH = 0

const isFinitePoint = (point) =>
  Array.isArray(point)
  && point.length >= 2
  && Number.isFinite(point[0])
  && Number.isFinite(point[1])

const resolveTailSeedDirection = (index) => {
  const seed = (Math.imul((index + 1) ^ 0x9e3779b9, 2654435761) >>> 0)
  const angle = (seed % 6283) / 1000
  return {
    x: Math.cos(angle),
    y: Math.sin(angle),
  }
}

let state = null

const samplePoint = (index, progress, out) => {
  if (!state) {
    out[0] = 0
    out[1] = 0
    return
  }

  const p = clamp(progress, 0, 1)
  const sampleProgress = p >= 1 && state.frameCount > 1
    ? 1 - VORONOI_FINAL_BACKOFF
    : p
  const base2 = index * 2

  if (sampleProgress <= 0) {
    out[0] = state.sourcePositions[base2]
    out[1] = state.sourcePositions[base2 + 1]
    return
  }

  if (sampleProgress >= 1) {
    out[0] = state.targetPositions[base2]
    out[1] = state.targetPositions[base2 + 1]
    return
  }

  const frameProgress = sampleProgress * Math.max(0, state.frameCount - 1)
  const frameA = Math.floor(frameProgress)
  const frameB = Math.min(state.frameCount - 1, frameA + 1)
  const localT = frameProgress - frameA

  const indexA = (frameA * state.count + index) * 2
  const indexB = (frameB * state.count + index) * 2

  const targetX = state.targetPositions[base2]
  const targetY = state.targetPositions[base2 + 1]

  let x = state.motionPath[indexA] + (state.motionPath[indexB] - state.motionPath[indexA]) * localT
  let y = state.motionPath[indexA + 1] + (state.motionPath[indexB + 1] - state.motionPath[indexA + 1]) * localT

  const settle = smoothstep((sampleProgress - VORONOI_SETTLE_START) / VORONOI_SETTLE_DURATION) * VORONOI_SETTLE_STRENGTH
  x += (targetX - x) * settle
  y += (targetY - y) * settle

  const tailT = clamp((sampleProgress - VORONOI_TAIL_ADJUST_START) / VORONOI_TAIL_ADJUST_DURATION, 0, 1)

  if (VORONOI_TAIL_ADJUST_STRENGTH > 0 && tailT > 0 && sampleProgress < 1) {
    const reachBlend = smoothstep(clamp(tailT / 0.32, 0, 1))
    x += (targetX - x) * reachBlend
    y += (targetY - y) * reachBlend

    const probeStep = clamp(Math.max(1 / Math.max(2, state.frameCount - 1), 0.01), 0.006, 0.06)
    const probeProgress = clamp(sampleProgress - probeStep, 0, 1)
    const probeFrameProgress = probeProgress * Math.max(0, state.frameCount - 1)
    const probeFrameA = Math.floor(probeFrameProgress)
    const probeFrameB = Math.min(state.frameCount - 1, probeFrameA + 1)
    const probeLocalT = probeFrameProgress - probeFrameA
    const probeIndexA = (probeFrameA * state.count + index) * 2
    const probeIndexB = (probeFrameB * state.count + index) * 2

    let probeX = state.motionPath[probeIndexA] + (state.motionPath[probeIndexB] - state.motionPath[probeIndexA]) * probeLocalT
    let probeY = state.motionPath[probeIndexA + 1] + (state.motionPath[probeIndexB + 1] - state.motionPath[probeIndexA + 1]) * probeLocalT
    const probeSettle = smoothstep((probeProgress - VORONOI_SETTLE_START) / VORONOI_SETTLE_DURATION) * VORONOI_SETTLE_STRENGTH
    probeX += (targetX - probeX) * probeSettle
    probeY += (targetY - probeY) * probeSettle

    let dirX = targetX - probeX
    let dirY = targetY - probeY
    let dirLength = Math.hypot(dirX, dirY)

    if (!Number.isFinite(dirLength) || dirLength < 0.0001) {
      const seed = resolveTailSeedDirection(index)
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
    const amplitude = motionScale * 0.4 * VORONOI_TAIL_ADJUST_STRENGTH * decay

    x += dirX * primaryWave * amplitude + normalX * secondaryWave * amplitude * 0.34
    y += dirY * primaryWave * amplitude + normalY * secondaryWave * amplitude * 0.34

    const offsetX = x - targetX
    const offsetY = y - targetY
    const offsetLength = Math.hypot(offsetX, offsetY)
    const maxOffset = (0.32 + 0.22 * (1 - tailT)) * VORONOI_TAIL_ADJUST_STRENGTH

    if (offsetLength > maxOffset && offsetLength > 0.0001) {
      const ratio = maxOffset / offsetLength
      x = targetX + offsetX * ratio
      y = targetY + offsetY * ratio
    }
  }

  out[0] = x
  out[1] = y
}

const buildVoronoiMesh = (progress) => {
  const count = state?.count || 0
  if (!count) {
    return {
      offsets: new Uint32Array(1),
      points: new Float32Array(0),
    }
  }

  const coords = new Float64Array(count * 2)
  const point = [0, 0]

  for (let index = 0; index < count; index += 1) {
    samplePoint(index, progress, point)
    const base2 = index * 2
    coords[base2] = clamp(point[0], 0, state.width)
    coords[base2 + 1] = clamp(point[1], 0, state.height)
  }

  const delaunay = new Delaunay(coords)
  const voronoi = delaunay.voronoi([0, 0, state.width, state.height])
  const offsets = new Uint32Array(count + 1)
  const points = []
  let cursor = 0

  for (let index = 0; index < count; index += 1) {
    offsets[index] = cursor

    const polygon = voronoi.cellPolygon(index)
    if (!polygon || polygon.length < 3) continue

    if (!isFinitePoint(polygon[0])) continue

    let valid = true
    for (let pointIndex = 1; pointIndex < polygon.length; pointIndex += 1) {
      if (!isFinitePoint(polygon[pointIndex])) {
        valid = false
        break
      }
    }

    if (!valid) continue

    for (let pointIndex = 0; pointIndex < polygon.length; pointIndex += 1) {
      const [x, y] = polygon[pointIndex]
      points.push(x, y)
      cursor += 2
    }
  }

  offsets[count] = cursor

  return {
    offsets,
    points: Float32Array.from(points),
  }
}

self.onmessage = (event) => {
  const payload = event.data || {}

  if (payload.type === 'dispose') {
    state = null
    return
  }

  if (payload.type === 'init') {
    const count = Math.max(0, Math.round(Number(payload.count) || 0))
    const frameCount = Math.max(1, Math.round(Number(payload.frameCount) || 1))

    state = {
      width: Math.max(2, Math.round(Number(payload.width) || 2)),
      height: Math.max(2, Math.round(Number(payload.height) || 2)),
      count,
      frameCount,
      sourcePositions: payload.sourcePositions instanceof Float32Array ? payload.sourcePositions : new Float32Array(0),
      targetPositions: payload.targetPositions instanceof Float32Array ? payload.targetPositions : new Float32Array(0),
      motionPath: payload.motionPath instanceof Float32Array ? payload.motionPath : new Float32Array(0),
    }

    self.postMessage({
      type: 'ready',
      requestId: payload.requestId,
      count,
    })

    return
  }

  if (payload.type !== 'frame') return

  if (!state) {
    self.postMessage({
      type: 'error',
      requestId: payload.requestId,
      message: 'Render worker not initialized.',
    })
    return
  }

  const progress = clamp(Number(payload.progress) || 0, 0, 1)

  try {
    const mesh = buildVoronoiMesh(progress)

    self.postMessage(
      {
        type: 'frame',
        requestId: payload.requestId,
        progress,
        offsets: mesh.offsets,
        points: mesh.points,
      },
      [mesh.offsets.buffer, mesh.points.buffer],
    )
  } catch (error) {
    self.postMessage({
      type: 'error',
      requestId: payload.requestId,
      message: error?.message || 'Voronoi frame build failed.',
    })
  }
}