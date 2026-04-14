import { Delaunay } from 'd3-delaunay'

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

const smoothstep = (t) => {
  const value = clamp(t, 0, 1)
  return value * value * (3 - 2 * value)
}

const isFinitePoint = (point) =>
  Array.isArray(point)
  && point.length >= 2
  && Number.isFinite(point[0])
  && Number.isFinite(point[1])

let state = null

const samplePoint = (index, progress, out) => {
  if (!state) {
    out[0] = 0
    out[1] = 0
    return
  }

  const p = clamp(progress, 0, 1)
  const base2 = index * 2

  if (p <= 0) {
    out[0] = state.sourcePositions[base2]
    out[1] = state.sourcePositions[base2 + 1]
    return
  }

  if (p >= 1) {
    out[0] = state.targetPositions[base2]
    out[1] = state.targetPositions[base2 + 1]
    return
  }

  const frameProgress = p * Math.max(0, state.frameCount - 1)
  const frameA = Math.floor(frameProgress)
  const frameB = Math.min(state.frameCount - 1, frameA + 1)
  const localT = frameProgress - frameA

  const indexA = (frameA * state.count + index) * 2
  const indexB = (frameB * state.count + index) * 2

  let x = state.motionPath[indexA] + (state.motionPath[indexB] - state.motionPath[indexA]) * localT
  let y = state.motionPath[indexA + 1] + (state.motionPath[indexB + 1] - state.motionPath[indexA + 1]) * localT

  const settle = smoothstep((p - 0.78) / 0.22)
  x += (state.targetPositions[base2] - x) * settle
  y += (state.targetPositions[base2 + 1] - y) * settle

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
    coords[base2] = point[0]
    coords[base2 + 1] = point[1]
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