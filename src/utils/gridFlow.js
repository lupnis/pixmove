const MAX_FLOW_CACHE_BYTES = 32 * 1024 * 1024
const MAX_FLOW_FRAME_COUNT = 1200

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

const clampIndex = (value, maxExclusive) => {
  const parsed = Number.isFinite(Number(value)) ? Number(value) : 0
  return clamp(Math.round(parsed), 0, Math.max(0, maxExclusive - 1))
}

const resolveGridDimensions = (grid, count) => {
  const columns = Number.isFinite(Number(grid?.columns))
    ? Math.max(1, Math.round(Number(grid.columns)))
    : Number.isFinite(Number(grid?.side))
      ? Math.max(1, Math.round(Number(grid.side)))
      : Math.max(1, Math.round(Math.sqrt(Math.max(1, count))))
  const rows = Number.isFinite(Number(grid?.rows))
    ? Math.max(1, Math.round(Number(grid.rows)))
    : Number.isFinite(Number(grid?.side))
      ? Math.max(1, Math.round(Number(grid.side)))
      : Math.max(1, Math.ceil(Math.max(1, count) / columns))

  return { columns, rows }
}

const buildSnakePath = (columns, rows, count) => {
  const pathToCell = new Uint32Array(count)
  const cellToPath = new Uint32Array(count)

  let cursor = 0

  for (let y = 0; y < rows && cursor < count; y += 1) {
    if ((y & 1) === 0) {
      for (let x = 0; x < columns && cursor < count; x += 1) {
        const cell = y * columns + x
        if (cell >= count) continue
        pathToCell[cursor] = cell
        cellToPath[cell] = cursor
        cursor += 1
      }
    } else {
      for (let x = columns - 1; x >= 0 && cursor < count; x -= 1) {
        const cell = y * columns + x
        if (cell >= count) continue
        pathToCell[cursor] = cell
        cellToPath[cell] = cursor
        cursor += 1
      }
    }
  }

  return { pathToCell, cellToPath }
}

const resolveFlowFrameCount = (count, gridFrameCount) => {
  const safeCount = Math.max(1, Math.round(count || 1))
  const baseline = Math.max(2, Math.round(Number(gridFrameCount) || 96))
  const desired = Math.max(baseline * 4, Math.ceil(Math.sqrt(safeCount) * 10))
  // Source-cell timeline uses Uint16 entries (2 bytes per source per frame).
  const memoryLimit = Math.max(2, Math.floor((MAX_FLOW_CACHE_BYTES / 2) / safeCount))
  const cap = Math.max(2, Math.min(MAX_FLOW_FRAME_COUNT, memoryLimit))

  return clamp(desired, 2, cap)
}

const buildSourceStyleLut = (grid, count) => {
  const colors = new Uint32Array(count)
  const alphas = new Float32Array(count)
  const fillStyles = new Array(count)

  for (let sourceIndex = 0; sourceIndex < count; sourceIndex += 1) {
    const base = sourceIndex * 4
    const red = grid.sourceColors?.[base] ?? 255
    const green = grid.sourceColors?.[base + 1] ?? 255
    const blue = grid.sourceColors?.[base + 2] ?? 255
    const alpha = clamp((grid.sourceColors?.[base + 3] ?? 255) / 255, 0.16, 1)

    colors[sourceIndex] = (red << 16) | (green << 8) | blue
    alphas[sourceIndex] = alpha
    fillStyles[sourceIndex] = `rgba(${red}, ${green}, ${blue}, ${alpha})`
  }

  return {
    colors,
    alphas,
    fillStyles,
  }
}

const buildSourceCellFrames = (grid, count, frameCount, pathToCell, cellToPath) => {
  const keyBySource = new Uint32Array(count)
  const pathItems = new Uint32Array(count)
  const sourceCellByFrame = new Uint16Array(frameCount * count)

  for (let sourceIndex = 0; sourceIndex < count; sourceIndex += 1) {
    const targetCell = clampIndex(grid.sourceToTarget?.[sourceIndex] ?? sourceIndex, count)
    keyBySource[sourceIndex] = cellToPath[targetCell]
  }

  for (let pathIndex = 0; pathIndex < count; pathIndex += 1) {
    pathItems[pathIndex] = pathToCell[pathIndex]
  }

  const snapshotFrame = (frameIndex) => {
    const offset = frameIndex * count

    for (let pathIndex = 0; pathIndex < count; pathIndex += 1) {
      const sourceIndex = pathItems[pathIndex]
      const cellIndex = pathToCell[pathIndex]
      sourceCellByFrame[offset + sourceIndex] = cellIndex
    }
  }

  snapshotFrame(0)

  const totalPasses = count
  let passesDone = 0

  for (let frame = 1; frame < frameCount; frame += 1) {
    const scheduledPasses = Math.round((totalPasses * frame) / Math.max(1, frameCount - 1))
    const framePasses = Math.max(0, scheduledPasses - passesDone)

    for (let pass = 0; pass < framePasses; pass += 1) {
      const phase = (passesDone + pass) & 1

      for (let pathIndex = phase; pathIndex < count - 1; pathIndex += 2) {
        const leftSource = pathItems[pathIndex]
        const rightSource = pathItems[pathIndex + 1]

        if (keyBySource[leftSource] > keyBySource[rightSource]) {
          pathItems[pathIndex] = rightSource
          pathItems[pathIndex + 1] = leftSource
        }
      }
    }

    passesDone += framePasses
    snapshotFrame(frame)
  }

  return sourceCellByFrame
}

const flowCache = new WeakMap()

const getFrameCache = (grid) => {
  let frameCache = flowCache.get(grid)
  if (!frameCache) {
    frameCache = new Map()
    flowCache.set(grid, frameCache)
  }
  return frameCache
}

export const getGridFlowRenderState = (grid, frameCountHint) => {
  const count = Math.max(0, Math.round(Number(grid?.count) || 0))

  if (!count) {
    return {
      count: 0,
      frameCount: 2,
      sourceCellByFrame: new Uint16Array(0),
      colors: new Uint32Array(0),
      alphas: new Float32Array(0),
      fillStyles: [],
    }
  }

  const { columns, rows } = resolveGridDimensions(grid, count)
  const frameCount = resolveFlowFrameCount(count, frameCountHint ?? grid?.frameCount)
  const cacheKey = `${columns}x${rows}:${frameCount}`
  const frameCache = getFrameCache(grid)

  if (frameCache.has(cacheKey)) {
    return frameCache.get(cacheKey)
  }

  const { pathToCell, cellToPath } = buildSnakePath(columns, rows, count)
  const sourceCellByFrame = buildSourceCellFrames(grid, count, frameCount, pathToCell, cellToPath)
  const styleLut = buildSourceStyleLut(grid, count)

  const state = {
    count,
    frameCount,
    sourceCellByFrame,
    colors: styleLut.colors,
    alphas: styleLut.alphas,
    fillStyles: styleLut.fillStyles,
  }

  frameCache.set(cacheKey, state)
  return state
}
