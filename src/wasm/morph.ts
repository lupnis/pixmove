let heapOffset: usize = 0
let rngState: u32 = 1

@inline
function maxI32(a: i32, b: i32): i32 {
  return a > b ? a : b
}

@inline
function minI32(a: i32, b: i32): i32 {
  return a < b ? a : b
}

@inline
function clampI32(value: i32, min: i32, max: i32): i32 {
  return minI32(maxI32(value, min), max)
}

@inline
function clampF32(value: f32, min: f32, max: f32): f32 {
  return Mathf.min(max, Mathf.max(min, value))
}

@inline
function colorOffset(ptr: usize, index: i32): usize {
  return ptr + (<usize>index << 2)
}

@inline
function pairOffset(ptr: usize, index: i32): usize {
  return ptr + (<usize>index << 3)
}

@inline
function motionOffset(ptr: usize, frame: i32, count: i32, index: i32): usize {
  return ptr + (<usize>(frame * count + index) << 3)
}

@inline
function scalarF32Offset(ptr: usize, index: i32): usize {
  return ptr + (<usize>index << 2)
}

@inline
function scalarF64Offset(ptr: usize, index: i32): usize {
  return ptr + (<usize>index << 3)
}

function ensureCapacity(next: usize): void {
  const current = <usize>memory.size() << 16

  if (next > current) {
    const delta = next - current
    const pages = <i32>((delta + 0xffff) >> 16)
    memory.grow(pages)
  }
}

export function resetHeap(): void {
  heapOffset = 0
}

export function alloc(size: usize): usize {
  const aligned = (size + 7) & ~7
  const ptr = heapOffset
  const next = ptr + aligned

  ensureCapacity(next)
  heapOffset = next

  return ptr
}

function hash2D(x: u32, y: u32): u32 {
  let h = x * 374761393 + y * 668265263
  h = <u32>Math.imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 0
}

function seedRng(seed: u32): void {
  rngState = seed != 0 ? seed : 1
}

function nextRandom(): f64 {
  rngState = (rngState + 0x6d2b79f5) >>> 0

  let t = rngState
  t = <u32>Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + <u32>Math.imul(t ^ (t >>> 7), t | 61)

  return <f64>((t ^ (t >>> 14)) >>> 0) / 4294967296.0
}

function colorDistanceSq(sourceColorsPtr: usize, targetColorsPtr: usize, sourceIndex: i32, targetIndex: i32): i32 {
  const sourceBase = colorOffset(sourceColorsPtr, sourceIndex)
  const targetBase = colorOffset(targetColorsPtr, targetIndex)

  const dr = <i32>load<u8>(sourceBase) - <i32>load<u8>(targetBase)
  const dg = <i32>load<u8>(sourceBase + 1) - <i32>load<u8>(targetBase + 1)
  const db = <i32>load<u8>(sourceBase + 2) - <i32>load<u8>(targetBase + 2)

  return dr * dr + dg * dg + db * db
}

function calcHeuristic(
  sourceColorsPtr: usize,
  targetColorsPtr: usize,
  targetWeightsPtr: usize,
  sourceIndex: i32,
  targetIndex: i32,
  gridWidth: i32,
  gridHeight: i32,
  proximityFactor: f32,
): f64 {
  const dx = <f64>((targetIndex % gridWidth) - (sourceIndex % gridWidth))
  const dy = <f64>((targetIndex / gridWidth) - (sourceIndex / gridWidth))
  const spatial = dx * dx + dy * dy
  const color = <f64>colorDistanceSq(sourceColorsPtr, targetColorsPtr, sourceIndex, targetIndex)
  const weight = <f64>load<f32>(scalarF32Offset(targetWeightsPtr, targetIndex))
  const spatialWeight = <f64>proximityFactor / <f64>maxI32(gridWidth, gridHeight)
  const spatialCost = spatial * spatialWeight

  return color * weight + spatialCost * spatialCost
}

export function computeAssignments(
  sourceColorsPtr: usize,
  targetColorsPtr: usize,
  targetWeightsPtr: usize,
  targetToSourcePtr: usize,
  sourceToTargetPtr: usize,
  heuristicsPtr: usize,
  statsPtr: usize,
  gridWidth: i32,
  gridHeight: i32,
  count: i32,
  proximityFactor: f32,
  maxGenerations: i32,
  swapsPerGeneration: i32,
): void {
  for (let index = 0; index < count; index += 1) {
    store<u32>(scalarF32Offset(targetToSourcePtr, index), <u32>index)
    store<f64>(
      scalarF64Offset(heuristicsPtr, index),
      calcHeuristic(
        sourceColorsPtr,
        targetColorsPtr,
        targetWeightsPtr,
        index,
        index,
        gridWidth,
        gridHeight,
        proximityFactor,
      ),
    )
  }

  seedRng(hash2D(<u32>gridWidth, <u32>(gridHeight ^ count)))

  let acceptedSwaps = 0
  let generationCount = 0
  let maxDist = <f64>maxI32(gridWidth, gridHeight)

  for (let generation = 0; generation < maxGenerations; generation += 1) {
    let swapsMade = 0
    const distance = maxI32(2, <i32>Math.round(maxDist))

    for (let attempt = 0; attempt < swapsPerGeneration; attempt += 1) {
      const aPos = <i32>(nextRandom() * <f64>count)
      const ax = aPos % gridWidth
      const ay = aPos / gridWidth
      const bx = clampI32(ax + <i32>(nextRandom() * <f64>(distance * 2 + 1)) - distance, 0, gridWidth - 1)
      const by = clampI32(ay + <i32>(nextRandom() * <f64>(distance * 2 + 1)) - distance, 0, gridHeight - 1)
      const bPos = by * gridWidth + bx

      if (aPos == bPos) continue

      const sourceA = <i32>load<u32>(scalarF32Offset(targetToSourcePtr, aPos))
      const sourceB = <i32>load<u32>(scalarF32Offset(targetToSourcePtr, bPos))

      const current = load<f64>(scalarF64Offset(heuristicsPtr, aPos))
        + load<f64>(scalarF64Offset(heuristicsPtr, bPos))

      const nextA = calcHeuristic(
        sourceColorsPtr,
        targetColorsPtr,
        targetWeightsPtr,
        sourceB,
        aPos,
        gridWidth,
        gridHeight,
        proximityFactor,
      )
      const nextB = calcHeuristic(
        sourceColorsPtr,
        targetColorsPtr,
        targetWeightsPtr,
        sourceA,
        bPos,
        gridWidth,
        gridHeight,
        proximityFactor,
      )

      if (nextA + nextB < current) {
        store<u32>(scalarF32Offset(targetToSourcePtr, aPos), <u32>sourceB)
        store<u32>(scalarF32Offset(targetToSourcePtr, bPos), <u32>sourceA)
        store<f64>(scalarF64Offset(heuristicsPtr, aPos), nextA)
        store<f64>(scalarF64Offset(heuristicsPtr, bPos), nextB)
        swapsMade += 1
      }
    }

    acceptedSwaps += swapsMade
    generationCount = generation + 1

    const minSwaps = maxI32(8, <i32>(<f64>count * 0.002))

    if (maxDist <= 2.2 && swapsMade < minSwaps) {
      break
    }

    maxDist *= 0.985

    if (maxDist < 2.0) {
      maxDist = 2.0
    }
  }

  for (let targetIndex = 0; targetIndex < count; targetIndex += 1) {
    const sourceIndex = <i32>load<u32>(scalarF32Offset(targetToSourcePtr, targetIndex))
    store<u32>(scalarF32Offset(sourceToTargetPtr, sourceIndex), <u32>targetIndex)
  }

  store<i32>(statsPtr, generationCount)
  store<i32>(statsPtr + 4, acceptedSwaps)
}

export function simulateMotion(
  sourcePositionsPtr: usize,
  targetPositionsPtr: usize,
  motionPathPtr: usize,
  width: f32,
  height: f32,
  gridWidth: i32,
  gridHeight: i32,
  count: i32,
  frameCount: i32,
  substeps: i32,
): void {
  if (count <= 0) {
    return
  }

  const safeGridWidth = maxI32(1, gridWidth)
  const safeGridHeight = maxI32(1, gridHeight)
  const safeFrames = maxI32(1, frameCount)
  const safeSubsteps = maxI32(1, substeps)
  const positionsBytes = <usize>(count << 3)
  const positionsPtr = alloc(positionsBytes)
  const velocitiesPtr = alloc(positionsBytes)
  const accelerationsPtr = alloc(positionsBytes)
  const agesPtr = alloc(<usize>(count << 1))
  const nextLinkPtr = alloc(<usize>(count << 2))
  const gridHeadPtr = alloc(<usize>((safeGridWidth * safeGridHeight) << 2))

  memory.copy(positionsPtr, sourcePositionsPtr, positionsBytes)
  memory.fill(velocitiesPtr, 0, positionsBytes)
  memory.fill(accelerationsPtr, 0, positionsBytes)
  memory.fill(agesPtr, 0, <usize>(count << 1))

  const cellWidth: f32 = width / <f32>safeGridWidth
  const cellHeight: f32 = height / <f32>safeGridHeight
  const pixelSize: f32 = Mathf.min(cellWidth, cellHeight)
  const personalSpace: f32 = pixelSize * <f32>0.95
  const wallLimit: f32 = personalSpace * <f32>0.5
  const maxVelocity: f32 = clampF32(pixelSize * <f32>0.78, <f32>1.1, <f32>6.0)
  const maxAcceleration: f32 = clampF32(pixelSize * <f32>0.95, <f32>0.4, <f32>3.2)
  const destinationForceScale: f32 = clampF32(pixelSize / <f32>8.0, <f32>0.35, <f32>1.0)
  const alignmentFactor: f32 = 0.8
  const sideLength: f32 = Mathf.max(<f32>1.0, Mathf.max(width, height))

  // Frame 0 always starts from the exact source layout.
  memory.copy(motionPathPtr, positionsPtr, positionsBytes)

  for (let frame = 1; frame < safeFrames; frame += 1) {
    for (let step = 0; step < safeSubsteps; step += 1) {
      for (let g = 0, total = safeGridWidth * safeGridHeight; g < total; g += 1) {
        store<i32>(scalarF32Offset(gridHeadPtr, g), -1)
      }

      memory.fill(accelerationsPtr, 0, positionsBytes)

      for (let index = 0; index < count; index += 1) {
        const posPtr = pairOffset(positionsPtr, index)
        const accPtr = pairOffset(accelerationsPtr, index)
        const targetPtr = pairOffset(targetPositionsPtr, index)
        const x = load<f32>(posPtr)
        const y = load<f32>(posPtr + 4)
        const gx = clampI32(<i32>(x / cellWidth), 0, safeGridWidth - 1)
        const gy = clampI32(<i32>(y / cellHeight), 0, safeGridHeight - 1)
        const cellIndex = gy * safeGridWidth + gx

        store<i32>(scalarF32Offset(nextLinkPtr, index), load<i32>(scalarF32Offset(gridHeadPtr, cellIndex)))
        store<i32>(scalarF32Offset(gridHeadPtr, cellIndex), index)

        let ax: f32 = 0.0
        let ay: f32 = 0.0

        if (x < wallLimit) {
          ax += (wallLimit - x) / wallLimit
        } else if (x > width - wallLimit) {
          ax -= (x - (width - wallLimit)) / wallLimit
        }

        if (y < wallLimit) {
          ay += (wallLimit - y) / wallLimit
        } else if (y > height - wallLimit) {
          ay -= (y - (height - wallLimit)) / wallLimit
        }

        const elapsed: f32 = <f32>load<u16>(agesPtr + (<usize>index << 1)) / 60.0
        const factor: f32 = Mathf.min(Mathf.pow(elapsed * <f32>0.13, <f32>3.0), 1000.0)
        const dx: f32 = load<f32>(targetPtr) - x
        const dy: f32 = load<f32>(targetPtr + 4) - y
        const dist: f32 = Mathf.sqrt(dx * dx + dy * dy)

        ax += ((dx * dist * factor) / sideLength) * destinationForceScale
        ay += ((dy * dist * factor) / sideLength) * destinationForceScale

        store<f32>(accPtr, ax)
        store<f32>(accPtr + 4, ay)
      }

      for (let index = 0; index < count; index += 1) {
        const posPtr = pairOffset(positionsPtr, index)
        const velPtr = pairOffset(velocitiesPtr, index)
        const accPtr = pairOffset(accelerationsPtr, index)
        const x = load<f32>(posPtr)
        const y = load<f32>(posPtr + 4)
        const gx = clampI32(<i32>(x / cellWidth), 0, safeGridWidth - 1)
        const gy = clampI32(<i32>(y / cellHeight), 0, safeGridHeight - 1)

        let ax: f32 = load<f32>(accPtr)
        let ay: f32 = load<f32>(accPtr + 4)
        let avgVX: f32 = 0.0
        let avgVY: f32 = 0.0
        let weightSum: f32 = 0.0

        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            const nx = gx + ox
            const ny = gy + oy

            if (nx < 0 || ny < 0 || nx >= safeGridWidth || ny >= safeGridHeight) continue

            let other = load<i32>(scalarF32Offset(gridHeadPtr, ny * safeGridWidth + nx))

            while (other != -1) {
              if (other != index) {
                const otherPosPtr = pairOffset(positionsPtr, other)
                const otherVelPtr = pairOffset(velocitiesPtr, other)
                const dx: f32 = load<f32>(otherPosPtr) - x
                const dy: f32 = load<f32>(otherPosPtr + 4) - y
                const dist: f32 = Mathf.sqrt(dx * dx + dy * dy)

                if (dist > <f32>0.0001 && dist < personalSpace) {
                  const weight: f32 = (<f32>1.0 / dist) * (personalSpace - dist) / personalSpace
                  ax -= dx * weight
                  ay -= dy * weight
                  avgVX += load<f32>(otherVelPtr) * weight
                  avgVY += load<f32>(otherVelPtr + 4) * weight
                  weightSum += weight
                } else if (dist <= <f32>0.0001) {
                  const seed = hash2D(<u32>index, <u32>(frame * 17 + step * 7))
                  ax += (<f32>(seed & 1023) / 1023.0 - <f32>0.5) * <f32>0.1
                  ay += (<f32>((seed >>> 10) & 1023) / 1023.0 - <f32>0.5) * <f32>0.1
                }
              }

              other = load<i32>(scalarF32Offset(nextLinkPtr, other))
            }
          }
        }

        if (weightSum > 0.0) {
          avgVX /= weightSum
          avgVY /= weightSum
          ax += (avgVX - load<f32>(velPtr)) * alignmentFactor
          ay += (avgVY - load<f32>(velPtr + 4)) * alignmentFactor
        }

        const accDist: f32 = Mathf.sqrt(ax * ax + ay * ay)
        if (accDist > maxAcceleration && accDist > <f32>0.0001) {
          const limited = maxAcceleration / accDist
          ax *= limited
          ay *= limited
        }

        store<f32>(accPtr, ax)
        store<f32>(accPtr + 4, ay)
      }

      for (let index = 0; index < count; index += 1) {
        const posPtr = pairOffset(positionsPtr, index)
        const velPtr = pairOffset(velocitiesPtr, index)
        const accPtr = pairOffset(accelerationsPtr, index)
        const agePtr = agesPtr + (<usize>index << 1)

        const nextVX = clampF32((load<f32>(velPtr) + load<f32>(accPtr)) * <f32>0.97, -maxVelocity, maxVelocity)
        const nextVY = clampF32((load<f32>(velPtr + 4) + load<f32>(accPtr + 4)) * <f32>0.97, -maxVelocity, maxVelocity)

        store<f32>(velPtr, nextVX)
        store<f32>(velPtr + 4, nextVY)
        store<f32>(posPtr, clampF32(load<f32>(posPtr) + nextVX, 0.0, width))
        store<f32>(posPtr + 4, clampF32(load<f32>(posPtr + 4) + nextVY, 0.0, height))
        store<u16>(agePtr, <u16>(load<u16>(agePtr) + 1))
      }
    }

    memory.copy(motionPathPtr + <usize>(frame * count << 3), positionsPtr, positionsBytes)
  }

  if (safeFrames > 1) {
    const frameSpan: f32 = <f32>(safeFrames - 1)
    const minStep: f32 = Mathf.max(<f32>0.12, pixelSize * <f32>0.32)

    for (let index = 0; index < count; index += 1) {
      const sourcePtr = pairOffset(sourcePositionsPtr, index)
      const targetPtr = pairOffset(targetPositionsPtr, index)

      const sourceX = clampF32(load<f32>(sourcePtr), 0.0, width)
      const sourceY = clampF32(load<f32>(sourcePtr + 4), 0.0, height)
      const targetX = clampF32(load<f32>(targetPtr), 0.0, width)
      const targetY = clampF32(load<f32>(targetPtr + 4), 0.0, height)

      const pathDx = targetX - sourceX
      const pathDy = targetY - sourceY
      const pathDist = Mathf.sqrt(pathDx * pathDx + pathDy * pathDy)
      const avgStep = pathDist / frameSpan
      const maxStep = Mathf.max(minStep, avgStep * <f32>1.85)

      const firstPtr = motionOffset(motionPathPtr, 0, count, index)
      const lastPtr = motionOffset(motionPathPtr, safeFrames - 1, count, index)

      store<f32>(firstPtr, sourceX)
      store<f32>(firstPtr + 4, sourceY)
      store<f32>(lastPtr, targetX)
      store<f32>(lastPtr + 4, targetY)

      for (let frame = safeFrames - 2; frame > 0; frame -= 1) {
        const currentPtr = motionOffset(motionPathPtr, frame, count, index)
        const nextPtr = motionOffset(motionPathPtr, frame + 1, count, index)

        let currentX = load<f32>(currentPtr)
        let currentY = load<f32>(currentPtr + 4)
        const nextX = load<f32>(nextPtr)
        const nextY = load<f32>(nextPtr + 4)

        const dx = nextX - currentX
        const dy = nextY - currentY
        const dist = Mathf.sqrt(dx * dx + dy * dy)

        if (dist > maxStep && dist > <f32>0.0001) {
          const limited = maxStep / dist
          currentX = nextX - dx * limited
          currentY = nextY - dy * limited
        }

        store<f32>(currentPtr, clampF32(currentX, 0.0, width))
        store<f32>(currentPtr + 4, clampF32(currentY, 0.0, height))
      }

      for (let frame = 1; frame < safeFrames - 1; frame += 1) {
        const previousPtr = motionOffset(motionPathPtr, frame - 1, count, index)
        const currentPtr = motionOffset(motionPathPtr, frame, count, index)

        const prevX = load<f32>(previousPtr)
        const prevY = load<f32>(previousPtr + 4)
        let currentX = load<f32>(currentPtr)
        let currentY = load<f32>(currentPtr + 4)

        const dx = currentX - prevX
        const dy = currentY - prevY
        const dist = Mathf.sqrt(dx * dx + dy * dy)

        if (dist > maxStep && dist > <f32>0.0001) {
          const limited = maxStep / dist
          currentX = prevX + dx * limited
          currentY = prevY + dy * limited
        }

        store<f32>(currentPtr, clampF32(currentX, 0.0, width))
        store<f32>(currentPtr + 4, clampF32(currentY, 0.0, height))
      }
    }
  }
}
