import { createAssignmentsWasmRunner, createMotionSimulationWasmRunner } from './useMorphWasm'

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 0))
const resolveAssignmentChunkSize = (count) => {
  if (count >= 16000) return 1
  if (count >= 6000) return 2
  return 3
}
const resolveSimulationFrameChunk = (count) => {
  if (count >= 24000) return 1
  if (count >= 10000) return 2
  if (count >= 4000) return 4
  return 6
}
const resolveSimulationCellChunk = (count) => {
  if (count >= 24000) return 384
  if (count >= 10000) return 768
  if (count >= 4000) return 1200
  return 1800
}

const colorDistanceSq = (aBase, bBase, aColors, bColors) => {
  const dr = aColors[aBase] - bColors[bBase]
  const dg = aColors[aBase + 1] - bColors[bBase + 1]
  const db = aColors[aBase + 2] - bColors[bBase + 2]
  return dr * dr + dg * dg + db * db
}

const normalizeFloatArray = (values) => {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value < min) min = value
    if (value > max) max = value
  }

  const range = max - min
  if (!Number.isFinite(range) || range <= 0.000001) {
    values.fill(0)
    return values
  }

  for (let index = 0; index < values.length; index += 1) {
    values[index] = (values[index] - min) / range
  }

  return values
}

const collectGridCells = (pixels, width, height, columns, rows, onProgress) => {
  const count = columns * rows
  const bounds = new Uint16Array(count * 4)
  const colors = new Uint8Array(count * 4)
  const centers = new Float32Array(count * 2)
  const brightness = new Float32Array(count)
  const frequency = new Float32Array(count)
  const rasterWidth = Math.max(1, Math.round(width))
  const rasterHeight = Math.max(1, Math.round(height))
  const progressStep = Math.max(1, Math.floor(rows / 12))

  for (let gy = 0; gy < rows; gy += 1) {
    const y0 = Math.floor((gy * rasterHeight) / rows)
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * rasterHeight) / rows))

    for (let gx = 0; gx < columns; gx += 1) {
      const x0 = Math.floor((gx * rasterWidth) / columns)
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * rasterWidth) / columns))
      const index = gy * columns + gx
      const base4 = index * 4
      const base2 = index * 2

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let brightnessSum = 0
      let samples = 0
      const cellWidth = Math.max(1, x1 - x0)
      const cellHeight = Math.max(1, y1 - y0)
      const grey = new Float32Array(cellWidth * cellHeight)

      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const pixel = (y * rasterWidth + x) * 4
          const red = pixels[pixel]
          const green = pixels[pixel + 1]
          const blue = pixels[pixel + 2]
          const alpha = pixels[pixel + 3]
          const greyIndex = (y - y0) * cellWidth + (x - x0)
          const greyValue = red * 0.299 + green * 0.587 + blue * 0.114

          r += red
          g += green
          b += blue
          a += alpha
          brightnessSum += greyValue
          grey[greyIndex] = greyValue
          samples += 1
        }
      }

      colors[base4] = Math.round(r / Math.max(1, samples))
      colors[base4 + 1] = Math.round(g / Math.max(1, samples))
      colors[base4 + 2] = Math.round(b / Math.max(1, samples))
      colors[base4 + 3] = Math.round(a / Math.max(1, samples))
      brightness[index] = brightnessSum / Math.max(1, samples)

      let laplacianSum = 0
      for (let localY = 0; localY < cellHeight; localY += 1) {
        const topY = localY > 0 ? localY - 1 : localY
        const bottomY = localY < cellHeight - 1 ? localY + 1 : localY

        for (let localX = 0; localX < cellWidth; localX += 1) {
          const leftX = localX > 0 ? localX - 1 : localX
          const rightX = localX < cellWidth - 1 ? localX + 1 : localX
          const center = grey[localY * cellWidth + localX]
          const left = grey[localY * cellWidth + leftX]
          const right = grey[localY * cellWidth + rightX]
          const top = grey[topY * cellWidth + localX]
          const bottom = grey[bottomY * cellWidth + localX]
          laplacianSum += Math.abs(4 * center - left - right - top - bottom)
        }
      }

      frequency[index] = laplacianSum / Math.max(1, samples)

      const boundX0 = clamp(x0, 0, Math.max(0, rasterWidth - 1))
      const boundY0 = clamp(y0, 0, Math.max(0, rasterHeight - 1))
      const boundX1 = clamp(x1, boundX0 + 1, rasterWidth)
      const boundY1 = clamp(y1, boundY0 + 1, rasterHeight)

      bounds[base4] = boundX0
      bounds[base4 + 1] = boundY0
      bounds[base4 + 2] = Math.max(1, boundX1 - boundX0)
      bounds[base4 + 3] = Math.max(1, boundY1 - boundY0)

      centers[base2] = (x0 + x1) * 0.5
      centers[base2 + 1] = (y0 + y1) * 0.5
    }

    if (onProgress && (((gy + 1) % progressStep) === 0 || gy === rows - 1)) {
      onProgress((gy + 1) / rows)
    }
  }

  return {
    bounds,
    colors,
    centers,
    brightness: normalizeFloatArray(brightness),
    frequency: normalizeFloatArray(frequency),
    count,
  }
}

const computeTargetWeights = (targetColors, columns, rows, onProgress) => {
  const count = columns * rows
  const weights = new Float32Array(count)
  let minWeight = Number.POSITIVE_INFINITY
  let maxWeight = 0
  const progressStep = Math.max(1, Math.floor(rows / 10))

  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      const index = y * columns + x
      const base = index * 4

      let contrast = 0
      let samples = 0

      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          if (!ox && !oy) continue

          const nx = x + ox
          const ny = y + oy
          if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue

          contrast += colorDistanceSq(base, (ny * columns + nx) * 4, targetColors, targetColors)
          samples += 1
        }
      }

      const edgeStrength = contrast / Math.max(1, samples)
      const weight = 1 + clamp(edgeStrength / 24000, 0, 3.25)
      weights[index] = weight
      minWeight = Math.min(minWeight, weight)
      maxWeight = Math.max(maxWeight, weight)
    }

    if (onProgress && (((y + 1) % progressStep) === 0 || y === rows - 1)) {
      onProgress((y + 1) / rows)
    }
  }

  return {
    weights,
    minWeight: Number.isFinite(minWeight) ? minWeight : 1,
    maxWeight,
  }
}

const resolveSeedDirection = (sourceIndex, targetIndex) => {
  const seed = (((sourceIndex + 1) * 73856093) ^ ((targetIndex + 1) * 19349663)) >>> 0
  const angle = (seed % 6283) / 1000
  return {
    x: Math.cos(angle),
    y: Math.sin(angle),
  }
}

const resolveWeightBoost = (weight) => clamp(((Number(weight) || 1) - 1) / 3.25, 0, 1)

const computeFinalSitePositions = (
  targetPositions,
  sourceToTarget,
  targetToSource,
  targetWeights,
  columns,
  rows,
  width,
  height,
) => {
  const count = columns * rows
  const finalPositions = new Float32Array(targetPositions)
  const delta = new Float32Array(count * 2)
  const cellSize = Math.max(0.75, Math.min(width / Math.max(1, columns), height / Math.max(1, rows)))
  const neighborOffsets = [
    [-1, 0], [1, 0], [0, -1], [0, 1],
    [-1, -1], [1, -1], [-1, 1], [1, 1],
  ]

  for (let sourceIndex = 0; sourceIndex < count; sourceIndex += 1) {
    const targetIndex = sourceToTarget[sourceIndex]
    const boost = resolveWeightBoost(targetWeights[targetIndex])
    const direction = resolveSeedDirection(sourceIndex, targetIndex)
    const base = sourceIndex * 2
    const jitter = cellSize * (0.04 + boost * 0.12)

    finalPositions[base] += direction.x * jitter
    finalPositions[base + 1] += direction.y * jitter
  }

  for (let iteration = 0; iteration < 8; iteration += 1) {
    delta.fill(0)

    for (let sourceIndex = 0; sourceIndex < count; sourceIndex += 1) {
      const targetIndex = sourceToTarget[sourceIndex]
      const tx = targetIndex % columns
      const ty = Math.floor(targetIndex / columns)
      const base = sourceIndex * 2
      const targetX = targetPositions[base]
      const targetY = targetPositions[base + 1]
      const currentX = finalPositions[base]
      const currentY = finalPositions[base + 1]
      const boost = resolveWeightBoost(targetWeights[targetIndex])
      const anchor = 0.12 + iteration * 0.015 - boost * 0.03

      delta[base] += (targetX - currentX) * anchor
      delta[base + 1] += (targetY - currentY) * anchor

      for (const [offsetX, offsetY] of neighborOffsets) {
        const neighborX = tx + offsetX
        const neighborY = ty + offsetY
        if (neighborX < 0 || neighborY < 0 || neighborX >= columns || neighborY >= rows) continue

        const neighborTargetIndex = neighborY * columns + neighborX
        const otherSourceIndex = targetToSource[neighborTargetIndex]
        if (otherSourceIndex < 0 || otherSourceIndex === sourceIndex || sourceIndex > otherSourceIndex) continue

        const otherBase = otherSourceIndex * 2
        let dx = finalPositions[otherBase] - currentX
        let dy = finalPositions[otherBase + 1] - currentY
        let distance = Math.hypot(dx, dy)
        const neighborBoost = resolveWeightBoost(targetWeights[neighborTargetIndex])
        const desired = cellSize * (0.88 + (boost + neighborBoost) * 0.14)

        if (distance < 0.0001) {
          const direction = resolveSeedDirection(sourceIndex, neighborTargetIndex)
          dx = direction.x
          dy = direction.y
          distance = 1
        }

        const nx = dx / distance
        const ny = dy / distance

        if (distance < desired) {
          const push = (desired - distance) * 0.22
          delta[base] -= nx * push
          delta[base + 1] -= ny * push
          delta[otherBase] += nx * push
          delta[otherBase + 1] += ny * push
        } else if (distance > desired * 1.55) {
          const pull = Math.min(cellSize * 0.04, (distance - desired * 1.55) * 0.018)
          delta[base] += nx * pull
          delta[base + 1] += ny * pull
          delta[otherBase] -= nx * pull
          delta[otherBase + 1] -= ny * pull
        }
      }
    }

    for (let sourceIndex = 0; sourceIndex < count; sourceIndex += 1) {
      const targetIndex = sourceToTarget[sourceIndex]
      const boost = resolveWeightBoost(targetWeights[targetIndex])
      const base = sourceIndex * 2
      const targetX = targetPositions[base]
      const targetY = targetPositions[base + 1]
      let nextX = finalPositions[base] + delta[base]
      let nextY = finalPositions[base + 1] + delta[base + 1]
      const maxOffset = cellSize * (0.22 + boost * 0.2)
      const offsetX = nextX - targetX
      const offsetY = nextY - targetY
      const offsetLength = Math.hypot(offsetX, offsetY)

      if (offsetLength > maxOffset && offsetLength > 0.0001) {
        const scale = maxOffset / offsetLength
        nextX = targetX + offsetX * scale
        nextY = targetY + offsetY * scale
      }

      finalPositions[base] = clamp(nextX, 0, width)
      finalPositions[base + 1] = clamp(nextY, 0, height)
    }
  }

  return finalPositions
}

const matchPayload = async (payload) => {
  const {
    sourcePixels,
    targetPixels,
    width,
    height,
    gridWidth,
    gridHeight,
    proximityFactor,
    simulationFrames,
  } = payload

  const source = new Uint8ClampedArray(sourcePixels)
  const target = new Uint8ClampedArray(targetPixels)

  const rasterWidth = Math.max(1, Math.round(width))
  const rasterHeight = Math.max(1, Math.round(height))
  const columns = Math.max(1, Math.round(gridWidth))
  const rows = Math.max(1, Math.round(gridHeight))

  postMessage({ type: 'progress', id: payload.id, progress: 0, phase: 'cell_sampling_a' })
  const sourceGrid = collectGridCells(source, rasterWidth, rasterHeight, columns, rows, (progress) => {
    postMessage({ type: 'progress', id: payload.id, progress, phase: 'cell_sampling_a' })
  })
  postMessage({ type: 'progress', id: payload.id, progress: 1, phase: 'cell_sampling_a' })

  postMessage({ type: 'progress', id: payload.id, progress: 0, phase: 'cell_sampling_b' })
  const targetGrid = collectGridCells(target, rasterWidth, rasterHeight, columns, rows, (progress) => {
    postMessage({ type: 'progress', id: payload.id, progress, phase: 'cell_sampling_b' })
  })
  postMessage({ type: 'progress', id: payload.id, progress: 1, phase: 'cell_sampling_b' })

  postMessage({ type: 'progress', id: payload.id, progress: 0.04, phase: 'assignment' })
  const targetWeightInfo = computeTargetWeights(targetGrid.colors, columns, rows, (progress) => {
    postMessage({
      type: 'progress',
      id: payload.id,
      progress: 0.04 + progress * 0.08,
      phase: 'assignment',
    })
  })
  postMessage({ type: 'progress', id: payload.id, progress: 0.12, phase: 'assignment' })

  const assignmentRunner = await createAssignmentsWasmRunner(
    sourceGrid.brightness,
    sourceGrid.frequency,
    targetGrid.brightness,
    targetGrid.frequency,
    columns,
    rows,
    proximityFactor,
  )

  const assignmentChunkSize = resolveAssignmentChunkSize(sourceGrid.count)
  let assignmentStep = assignmentRunner.step(assignmentChunkSize)
  postMessage({
    type: 'progress',
    id: payload.id,
    progress: 0.12 + assignmentStep.progress * 0.88,
    phase: 'assignment',
  })

  while (!assignmentStep.done) {
    await yieldToEventLoop()
    assignmentStep = assignmentRunner.step(assignmentChunkSize)
    postMessage({
      type: 'progress',
      id: payload.id,
      progress: 0.12 + assignmentStep.progress * 0.88,
      phase: 'assignment',
    })
  }

  const assignment = assignmentRunner.finalize()

  postMessage({ type: 'progress', id: payload.id, progress: 1, phase: 'assignment' })

  const targetPositions = new Float32Array(sourceGrid.count * 2)

  for (let sourceIndex = 0; sourceIndex < sourceGrid.count; sourceIndex += 1) {
    const targetIndex = assignment.sourceToTarget[sourceIndex]
    const sourceBase = sourceIndex * 2
    const targetBase = targetIndex * 2

    targetPositions[sourceBase] = targetGrid.centers[targetBase]
    targetPositions[sourceBase + 1] = targetGrid.centers[targetBase + 1]
  }

  postMessage({ type: 'progress', id: payload.id, progress: 0, phase: 'simulation' })
  const motionRunner = await createMotionSimulationWasmRunner(
    sourceGrid.centers,
    targetPositions,
    rasterWidth,
    rasterHeight,
    columns,
    rows,
    simulationFrames,
  )

  const frameChunkSize = resolveSimulationFrameChunk(sourceGrid.count)
  const cellChunkSize = resolveSimulationCellChunk(sourceGrid.count)

  let motionFrameStep = motionRunner.stepFrames(frameChunkSize)
  postMessage({
    type: 'progress',
    id: payload.id,
    progress: motionFrameStep.progress * 0.82,
    phase: 'simulation',
  })

  while (!motionFrameStep.done) {
    await yieldToEventLoop()
    motionFrameStep = motionRunner.stepFrames(frameChunkSize)
    postMessage({
      type: 'progress',
      id: payload.id,
      progress: motionFrameStep.progress * 0.82,
      phase: 'simulation',
    })
  }

  let backwardStep = motionRunner.settleBackward(cellChunkSize)
  postMessage({
    type: 'progress',
    id: payload.id,
    progress: 0.82 + backwardStep.progress * 0.10,
    phase: 'simulation',
  })

  while (!backwardStep.done) {
    await yieldToEventLoop()
    backwardStep = motionRunner.settleBackward(cellChunkSize)
    postMessage({
      type: 'progress',
      id: payload.id,
      progress: 0.82 + backwardStep.progress * 0.10,
      phase: 'simulation',
    })
  }

  let forwardStep = motionRunner.settleForward(cellChunkSize)
  postMessage({
    type: 'progress',
    id: payload.id,
    progress: 0.92 + forwardStep.progress * 0.08,
    phase: 'simulation',
  })

  while (!forwardStep.done) {
    await yieldToEventLoop()
    forwardStep = motionRunner.settleForward(cellChunkSize)
    postMessage({
      type: 'progress',
      id: payload.id,
      progress: 0.92 + forwardStep.progress * 0.08,
      phase: 'simulation',
    })
  }

  const motionPath = motionRunner.finalize()

  postMessage({ type: 'progress', id: payload.id, progress: 1, phase: 'simulation' })

  const finalSitePositions = computeFinalSitePositions(
    targetPositions,
    assignment.sourceToTarget,
    assignment.targetToSource,
    targetWeightInfo.weights,
    columns,
    rows,
    rasterWidth,
    rasterHeight,
  )

  return {
    grid: {
      side: columns,
      columns,
      rows,
      count: sourceGrid.count,
      frameCount: simulationFrames,
      cellBounds: sourceGrid.bounds,
      sourceColors: sourceGrid.colors,
      targetColors: targetGrid.colors,
      targetToSource: assignment.targetToSource,
      sourceToTarget: assignment.sourceToTarget,
      sourcePositions: sourceGrid.centers,
      targetPositions,
      finalSitePositions,
      targetWeights: targetWeightInfo.weights,
      motionPath,
    },
    stats: {
      cellCount: sourceGrid.count,
      generationCount: assignment.stats[0],
      acceptedSwaps: assignment.stats[1],
      weightRange: [targetWeightInfo.minWeight, targetWeightInfo.maxWeight],
    },
  }
}

self.onmessage = async (event) => {
  const payload = event.data

  if (!payload || payload.type !== 'match') return

  try {
    const result = await matchPayload(payload)

    postMessage(
      {
        type: 'result',
        id: payload.id,
        result,
      },
      [
        result.grid.cellBounds.buffer,
        result.grid.sourceColors.buffer,
        result.grid.targetColors.buffer,
        result.grid.targetToSource.buffer,
        result.grid.sourceToTarget.buffer,
        result.grid.sourcePositions.buffer,
        result.grid.targetPositions.buffer,
        result.grid.finalSitePositions.buffer,
        result.grid.targetWeights.buffer,
        result.grid.motionPath.buffer,
      ],
    )
  } catch (error) {
    postMessage({
      type: 'error',
      id: payload.id,
      message: error?.message || 'Worker 计算失败。',
    })
  }
}
