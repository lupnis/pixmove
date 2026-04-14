import { Delaunay } from 'd3-delaunay'
import { clamp, sampleCellPosition, smoothstep } from './morphPlayback'

const nextHalfedge = (edge) => (edge % 3 === 2 ? edge - 2 : edge + 1)

const clampToBounds = (value, min, max) => Math.min(max, Math.max(min, value))

const resolveLocalRadius = (grid, sourceIndex) => {
  const boundBase = sourceIndex * 4
  const width = Math.max(0.5, Number(grid.cellBounds?.[boundBase + 2]) || 1)
  const height = Math.max(0.5, Number(grid.cellBounds?.[boundBase + 3]) || 1)
  return Math.max(0.32, Math.min(2.6, Math.min(width, height) * 0.46))
}

const resolveSeedDirection = (a, b, iteration) => {
  const seed = (((a + 1) * 73856093) ^ ((b + 1) * 19349663) ^ ((iteration + 1) * 83492791)) >>> 0
  const angle = (seed % 6283) / 1000
  return {
    x: Math.cos(angle),
    y: Math.sin(angle),
  }
}

export const resolveJamReveal = (progress) =>
  smoothstep(clamp((Number(progress) - 0.015) / 0.26, 0, 1))

export const createJamRenderState = (grid, renderData) => {
  const count = Math.max(0, Math.round(Number(renderData?.count) || 0))
  const sourceIndices = renderData?.indices || new Uint32Array(0)
  const targetX = new Float64Array(count)
  const targetY = new Float64Array(count)
  const radii = new Float32Array(count)
  const workX = new Float64Array(count)
  const workY = new Float64Array(count)
  const locked = new Uint8Array(count)

  for (let localIndex = 0; localIndex < count; localIndex += 1) {
    const sourceIndex = sourceIndices[localIndex]
    const base2 = sourceIndex * 2

    targetX[localIndex] = Number(grid.targetPositions?.[base2]) || 0
    targetY[localIndex] = Number(grid.targetPositions?.[base2 + 1]) || 0
    radii[localIndex] = resolveLocalRadius(grid, sourceIndex)
  }

  return {
    count,
    sourceIndices,
    targetX,
    targetY,
    radii,
    workX,
    workY,
    locked,
  }
}

export const sampleJamCenters = (
  grid,
  jamState,
  progress,
  outCoords,
  sampleOut,
  boundsWidth,
  boundsHeight,
) => {
  if (!jamState?.count || !outCoords?.length) {
    return
  }

  const count = jamState.count
  const p = clamp(progress, 0, 1)
  const maxX = Math.max(1, Number(boundsWidth) || 1)
  const maxY = Math.max(1, Number(boundsHeight) || 1)
  const revealBlend = resolveJamReveal(p)
  const settleBlend = smoothstep(clamp((p - 0.6) / 0.4, 0, 1))
  const lockBlend = smoothstep(clamp((p - 0.36) / 0.64, 0, 1))
  const tailBlend = smoothstep(clamp((p - 0.74) / 0.26, 0, 1))
  const hardCoreRatio = 0.9 + tailBlend * 0.03
  const neighborMaxRatio = 1.2 - tailBlend * 0.06
  const hardPushFactor = 0.82 + (1 - tailBlend) * 0.34
  const pullFactor = (0.035 + (1 - tailBlend) * 0.015) * revealBlend
  const baseSpring = (0.045 + settleBlend * 0.1) * (0.3 + revealBlend * 0.7)
  const iterations = p < 0.45 ? 2 : p < 0.82 ? 3 : 4

  for (let localIndex = 0; localIndex < count; localIndex += 1) {
    const sourceIndex = jamState.sourceIndices[localIndex]
    const targetX = jamState.targetX[localIndex]
    const targetY = jamState.targetY[localIndex]

    if (p >= 1) {
      jamState.workX[localIndex] = targetX
      jamState.workY[localIndex] = targetY
      jamState.locked[localIndex] = 1
      continue
    }

    sampleCellPosition(grid, sourceIndex, p, sampleOut)

    let x = sampleOut.x + (targetX - sampleOut.x) * settleBlend * 0.28
    let y = sampleOut.y + (targetY - sampleOut.y) * settleBlend * 0.28

    const toTargetX = targetX - x
    const toTargetY = targetY - y
    const targetDistance = Math.hypot(toTargetX, toTargetY)
    const lockRadius = Math.max(0.16, jamState.radii[localIndex] * (0.24 + lockBlend * 0.32))
    const isLocked = targetDistance <= lockRadius || p >= 1

    if (isLocked) {
      x = targetX
      y = targetY
      jamState.locked[localIndex] = 1
    } else {
      x += toTargetX * baseSpring
      y += toTargetY * baseSpring
      jamState.locked[localIndex] = 0
    }

    jamState.workX[localIndex] = clampToBounds(x, 0, maxX)
    jamState.workY[localIndex] = clampToBounds(y, 0, maxY)
  }

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const iterSpring = baseSpring * (iteration === 0 ? 0.92 : 0.58)

    for (let localIndex = 0; localIndex < count; localIndex += 1) {
      if (jamState.locked[localIndex]) {
        jamState.workX[localIndex] = jamState.targetX[localIndex]
        jamState.workY[localIndex] = jamState.targetY[localIndex]
        continue
      }

      jamState.workX[localIndex] += (jamState.targetX[localIndex] - jamState.workX[localIndex]) * iterSpring
      jamState.workY[localIndex] += (jamState.targetY[localIndex] - jamState.workY[localIndex]) * iterSpring
      jamState.workX[localIndex] = clampToBounds(jamState.workX[localIndex], 0, maxX)
      jamState.workY[localIndex] = clampToBounds(jamState.workY[localIndex], 0, maxY)
    }

    for (let localIndex = 0; localIndex < count; localIndex += 1) {
      const coordBase = localIndex * 2
      outCoords[coordBase] = jamState.workX[localIndex]
      outCoords[coordBase + 1] = jamState.workY[localIndex]
    }

    const delaunay = new Delaunay(outCoords)
    const triangles = delaunay.triangles
    const halfedges = delaunay.halfedges

    for (let edge = 0; edge < triangles.length; edge += 1) {
      const opposite = halfedges[edge]
      if (opposite !== -1 && edge > opposite) {
        continue
      }

      const a = triangles[edge]
      const b = triangles[nextHalfedge(edge)]
      if (a === b) {
        continue
      }

      const ax = jamState.workX[a]
      const ay = jamState.workY[a]
      const bx = jamState.workX[b]
      const by = jamState.workY[b]

      let dx = bx - ax
      let dy = by - ay
      let distance = Math.hypot(dx, dy)

      if (!Number.isFinite(distance)) {
        continue
      }

      if (distance < 0.0001) {
        const seedDirection = resolveSeedDirection(a, b, iteration)
        dx = seedDirection.x
        dy = seedDirection.y
        distance = 1
      }

      const baseDistance = jamState.radii[a] + jamState.radii[b]
      const hardDistance = baseDistance * hardCoreRatio
      const maxDistance = baseDistance * neighborMaxRatio
      const nx = dx / distance
      const ny = dy / distance
      const aLocked = jamState.locked[a] === 1
      const bLocked = jamState.locked[b] === 1

      if (distance < hardDistance) {
        const overlap = hardDistance - distance
        const push = overlap * hardPushFactor

        if (aLocked && bLocked) {
          continue
        }

        if (aLocked) {
          jamState.workX[b] += nx * push
          jamState.workY[b] += ny * push
        } else if (bLocked) {
          jamState.workX[a] -= nx * push
          jamState.workY[a] -= ny * push
        } else {
          const halfPush = push * 0.5
          jamState.workX[a] -= nx * halfPush
          jamState.workY[a] -= ny * halfPush
          jamState.workX[b] += nx * halfPush
          jamState.workY[b] += ny * halfPush
        }
        continue
      }

      if (distance > maxDistance && pullFactor > 0.000001) {
        const gap = distance - maxDistance
        const pull = gap * pullFactor

        if (aLocked && bLocked) {
          continue
        }

        if (aLocked) {
          jamState.workX[b] -= nx * pull
          jamState.workY[b] -= ny * pull
        } else if (bLocked) {
          jamState.workX[a] += nx * pull
          jamState.workY[a] += ny * pull
        } else {
          const halfPull = pull * 0.5
          jamState.workX[a] += nx * halfPull
          jamState.workY[a] += ny * halfPull
          jamState.workX[b] -= nx * halfPull
          jamState.workY[b] -= ny * halfPull
        }
      }
    }

    for (let localIndex = 0; localIndex < count; localIndex += 1) {
      if (jamState.locked[localIndex]) {
        jamState.workX[localIndex] = jamState.targetX[localIndex]
        jamState.workY[localIndex] = jamState.targetY[localIndex]
      } else {
        jamState.workX[localIndex] = clampToBounds(jamState.workX[localIndex], 0, maxX)
        jamState.workY[localIndex] = clampToBounds(jamState.workY[localIndex], 0, maxY)
      }
    }
  }

  for (let localIndex = 0; localIndex < count; localIndex += 1) {
    const coordBase = localIndex * 2

    if (p >= 1) {
      outCoords[coordBase] = jamState.targetX[localIndex]
      outCoords[coordBase + 1] = jamState.targetY[localIndex]
      continue
    }

    outCoords[coordBase] = jamState.workX[localIndex]
    outCoords[coordBase + 1] = jamState.workY[localIndex]
  }
}
