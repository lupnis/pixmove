import { clamp } from './morphPlayback'

const DEFAULT_TRANSPORT_FRAME_COUNT = 96
const MIN_TRANSPORT_FRAME_COUNT = 32
const MAX_TRANSPORT_FRAME_COUNT = 160
export const TRANSPORT_POLYGON_SEGMENTS = 14
const HOLD_RATIO = 0
const STIFFNESS = 0.012
const DAMPING = 0.88
const STRETCH_FACTOR = 0.1
const OVERLAP = 1.5
const MIN_SPEED = 0.0001

const transportStateCache = new WeakMap()

const resolveFrameCount = (grid) => {
  const raw = Math.round(Number(grid?.frameCount) || DEFAULT_TRANSPORT_FRAME_COUNT)
  return clamp(raw, MIN_TRANSPORT_FRAME_COUNT, MAX_TRANSPORT_FRAME_COUNT)
}

const resolveBaseSize = (grid, sourceIndex) => {
  const boundBase = sourceIndex * 4
  const width = Math.max(1, Number(grid?.cellBounds?.[boundBase + 2]) || 1)
  const height = Math.max(1, Number(grid?.cellBounds?.[boundBase + 3]) || 1)
  return Math.max(width, height)
}

const resolveFrameBase = (frame, count) => frame * count * 2
const resolvePointBase = (frame, count, index) => resolveFrameBase(frame, count) + index * 2

const clampAngleDelta = (value) => {
  let angle = value
  while (angle > Math.PI) angle -= Math.PI * 2
  while (angle < -Math.PI) angle += Math.PI * 2
  return angle
}

const lerpAngle = (a, b, t) => a + clampAngleDelta(b - a) * t

export const getTransportRenderState = (grid, renderData) => {
  if (!grid?.count || !renderData?.count) {
    return {
      count: 0,
      frameCount: 1,
      positions: new Float32Array(0),
      angles: new Float32Array(0),
      widths: new Float32Array(0),
      heights: new Float32Array(0),
      sourceIndices: new Uint32Array(0),
    }
  }

  if (transportStateCache.has(renderData)) {
    return transportStateCache.get(renderData)
  }

  const count = Math.max(0, Math.round(Number(renderData.count) || 0))
  const frameCount = resolveFrameCount(grid)
  const holdFrames = Math.min(frameCount - 1, Math.max(0, Math.round(frameCount * HOLD_RATIO)))
  const positions = new Float32Array(frameCount * count * 2)
  const angles = new Float32Array(frameCount * count)
  const widths = new Float32Array(frameCount * count)
  const heights = new Float32Array(frameCount * count)
  const sourceIndices = renderData.indices || new Uint32Array(0)
  const positionX = new Float32Array(count)
  const positionY = new Float32Array(count)
  const velocityX = new Float32Array(count)
  const velocityY = new Float32Array(count)
  const targetX = new Float32Array(count)
  const targetY = new Float32Array(count)
  const baseSizes = new Float32Array(count)

  for (let localIndex = 0; localIndex < count; localIndex += 1) {
    const sourceIndex = sourceIndices[localIndex]
    const base2 = sourceIndex * 2

    positionX[localIndex] = Number(grid.sourcePositions?.[base2]) || 0
    positionY[localIndex] = Number(grid.sourcePositions?.[base2 + 1]) || 0
    targetX[localIndex] = Number(grid.finalSitePositions?.[base2] ?? grid.targetPositions?.[base2]) || positionX[localIndex]
    targetY[localIndex] = Number(grid.finalSitePositions?.[base2 + 1] ?? grid.targetPositions?.[base2 + 1]) || positionY[localIndex]
    baseSizes[localIndex] = resolveBaseSize(grid, sourceIndex)
  }

  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let localIndex = 0; localIndex < count; localIndex += 1) {
      if (frame >= holdFrames) {
        const dx = targetX[localIndex] - positionX[localIndex]
        const dy = targetY[localIndex] - positionY[localIndex]
        velocityX[localIndex] = (velocityX[localIndex] + dx * STIFFNESS) * DAMPING
        velocityY[localIndex] = (velocityY[localIndex] + dy * STIFFNESS) * DAMPING
        positionX[localIndex] += velocityX[localIndex]
        positionY[localIndex] += velocityY[localIndex]

        const distance = Math.hypot(targetX[localIndex] - positionX[localIndex], targetY[localIndex] - positionY[localIndex])
        const speed = Math.hypot(velocityX[localIndex], velocityY[localIndex])

        if (distance <= 0.12 && speed <= 0.08) {
          positionX[localIndex] = targetX[localIndex]
          positionY[localIndex] = targetY[localIndex]
          velocityX[localIndex] = 0
          velocityY[localIndex] = 0
        }
      }

      if (frame === frameCount - 1) {
        positionX[localIndex] = targetX[localIndex]
        positionY[localIndex] = targetY[localIndex]
      }

      const pointBase = resolvePointBase(frame, count, localIndex)
      const velocityMagnitude = Math.max(MIN_SPEED, Math.hypot(velocityX[localIndex], velocityY[localIndex]))
      const stretch = clamp(1 + velocityMagnitude * STRETCH_FACTOR, 1, 4.4)
      const baseSize = baseSizes[localIndex]

      positions[pointBase] = positionX[localIndex]
      positions[pointBase + 1] = positionY[localIndex]
      angles[frame * count + localIndex] = Math.atan2(velocityY[localIndex], velocityX[localIndex])
      widths[frame * count + localIndex] = baseSize * stretch * OVERLAP
      heights[frame * count + localIndex] = baseSize * (1 / stretch) * OVERLAP
    }
  }

  const state = {
    count,
    frameCount,
    positions,
    angles,
    widths,
    heights,
    sourceIndices,
  }

  transportStateCache.set(renderData, state)
  return state
}

export const sampleTransportParticle = (state, progress, index, out = {}) => {
  const count = Math.max(0, Math.round(Number(state?.count) || 0))
  if (!count) {
    out.x = 0
    out.y = 0
    out.angle = 0
    out.width = 0
    out.height = 0
    return out
  }

  const safeIndex = clamp(Math.round(Number(index) || 0), 0, count - 1)
  const frameCount = Math.max(1, Math.round(Number(state?.frameCount) || 1))
  const p = clamp(Number(progress) || 0, 0, 1)
  const frameProgress = p * Math.max(0, frameCount - 1)
  const frameA = Math.floor(frameProgress)
  const frameB = Math.min(frameCount - 1, frameA + 1)
  const localT = frameProgress - frameA
  const pointA = resolvePointBase(frameA, count, safeIndex)
  const pointB = resolvePointBase(frameB, count, safeIndex)
  const scalarA = frameA * count + safeIndex
  const scalarB = frameB * count + safeIndex

  out.x = state.positions[pointA] + (state.positions[pointB] - state.positions[pointA]) * localT
  out.y = state.positions[pointA + 1] + (state.positions[pointB + 1] - state.positions[pointA + 1]) * localT
  out.angle = lerpAngle(state.angles[scalarA], state.angles[scalarB], localT)
  out.width = state.widths[scalarA] + (state.widths[scalarB] - state.widths[scalarA]) * localT
  out.height = state.heights[scalarA] + (state.heights[scalarB] - state.heights[scalarA]) * localT

  return out
}

export const writeEllipsePolygon = (
  outPoints,
  centerX,
  centerY,
  radiusX,
  radiusY,
  angle,
  segments = TRANSPORT_POLYGON_SEGMENTS,
) => {
  const count = Math.max(8, Math.round(segments))
  const requiredLength = count * 2

  if (!outPoints || outPoints.length < requiredLength) {
    return new Float32Array(requiredLength)
  }

  const cosAngle = Math.cos(angle)
  const sinAngle = Math.sin(angle)

  for (let index = 0; index < count; index += 1) {
    const theta = (index / count) * Math.PI * 2
    const localX = Math.cos(theta) * radiusX
    const localY = Math.sin(theta) * radiusY
    const pointBase = index * 2

    outPoints[pointBase] = centerX + localX * cosAngle - localY * sinAngle
    outPoints[pointBase + 1] = centerY + localX * sinAngle + localY * cosAngle
  }

  return outPoints
}
