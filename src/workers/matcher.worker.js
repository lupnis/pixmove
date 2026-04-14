import { computeAssignmentsWasm, simulateMotionWasm } from './useMorphWasm'

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

const colorDistanceSq = (aBase, bBase, aColors, bColors) => {
  const dr = aColors[aBase] - bColors[bBase]
  const dg = aColors[aBase + 1] - bColors[bBase + 1]
  const db = aColors[aBase + 2] - bColors[bBase + 2]
  return dr * dr + dg * dg + db * db
}

const collectGridCells = (pixels, width, height, columns, rows, onProgress) => {
  const count = columns * rows
  const bounds = new Uint16Array(count * 4)
  const colors = new Uint8Array(count * 4)
  const centers = new Float32Array(count * 2)
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
      let samples = 0

      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const pixel = (y * rasterWidth + x) * 4
          r += pixels[pixel]
          g += pixels[pixel + 1]
          b += pixels[pixel + 2]
          a += pixels[pixel + 3]
          samples += 1
        }
      }

      colors[base4] = Math.round(r / Math.max(1, samples))
      colors[base4 + 1] = Math.round(g / Math.max(1, samples))
      colors[base4 + 2] = Math.round(b / Math.max(1, samples))
      colors[base4 + 3] = Math.round(a / Math.max(1, samples))

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

  const assignment = await computeAssignmentsWasm(
    sourceGrid.colors,
    targetGrid.colors,
    targetWeightInfo.weights,
    columns,
    rows,
    proximityFactor,
  )

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
  const motionPath = await simulateMotionWasm(
    sourceGrid.centers,
    targetPositions,
    rasterWidth,
    rasterHeight,
    columns,
    rows,
    simulationFrames,
  )

  postMessage({ type: 'progress', id: payload.id, progress: 1, phase: 'simulation' })

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
