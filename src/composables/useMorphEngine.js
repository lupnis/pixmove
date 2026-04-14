import { Delaunay } from 'd3-delaunay'
import { clamp, sampleCellPosition, smoothstep } from '../utils/morphPlayback'
import { getMorphShapeBuffers, interpolateCellPolygon } from '../utils/morphPolygons'
import { getVoronoiRenderData } from '../utils/morphVoronoi'
import {
  DEFAULT_RENDERER_MODE,
  normalizeRendererMode,
  RENDERER_MODE_GRID,
  RENDERER_MODE_POLYGON,
  RENDERER_MODE_VORONOI,
} from '../utils/renderModes'

export {
  DEFAULT_RENDERER_MODE,
  normalizeRendererMode,
  RENDERER_MODE_GRID,
  RENDERER_MODE_POLYGON,
  RENDERER_MODE_VORONOI,
} from '../utils/renderModes'

export const DEFAULT_MORPH_WIDTH = 480
export const DEFAULT_MORPH_HEIGHT = 480
export const MIN_RESOLUTION_PERCENT = 4
export const MAX_RESOLUTION_PERCENT = 100
export const MAX_GRID_CELLS_AT_100 = 32768
export const MAX_CELL_RESOLUTION = Math.floor(Math.sqrt(MAX_GRID_CELLS_AT_100))

const MIN_RENDER_CELL_BUDGET = 128
const DEFAULT_GRID_CELL_BUDGET = 4200
const DEFAULT_POLYGON_CELL_BUDGET = 3200
const DEFAULT_VORONOI_CELL_BUDGET = 2600

const renderFrameStateCache = new WeakMap()

let matcherWorker = null
let requestSeed = 0
const pendingRequests = new Map()

const createAbortError = () => {
  const error = new Error('生成已停止。')
  error.name = 'AbortError'
  return error
}

const getMatcherWorker = () => {
  if (matcherWorker) return matcherWorker

  matcherWorker = new Worker(new URL('../workers/matcher.worker.js', import.meta.url), {
    type: 'module',
  })

  matcherWorker.onmessage = (event) => {
    const payload = event.data
    if (!payload || !payload.id) return

    const request = pendingRequests.get(payload.id)
    if (!request) return

    if (payload.type === 'progress') {
      request.onProgress?.(payload.phase, payload.progress)
      return
    }

    if (payload.type === 'result') {
      pendingRequests.delete(payload.id)
      request.resolve(payload.result)
      return
    }

    if (payload.type === 'error') {
      pendingRequests.delete(payload.id)
      request.reject(new Error(payload.message || 'Worker 计算失败。'))
    }
  }

  matcherWorker.onerror = (event) => {
    for (const [, request] of pendingRequests) {
      request.reject(new Error(event.message || 'Worker 执行异常。'))
    }

    pendingRequests.clear()
    matcherWorker = null
  }

  return matcherWorker
}

const runMatchingWorker = (payload, onProgress, signal) => {
  const worker = getMatcherWorker()
  const id = `match_${Date.now()}_${requestSeed++}`

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError())
      return
    }

    let settled = false

    const cleanup = () => {
      if (signal) {
        signal.removeEventListener('abort', onAbort)
      }
    }

    const onResolve = (result) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    const onReject = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const onAbort = () => {
      const abortError = createAbortError()

      for (const [, request] of pendingRequests) {
        request.reject(abortError)
      }

      pendingRequests.clear()

      if (matcherWorker) {
        matcherWorker.terminate()
        matcherWorker = null
      }

      onReject(abortError)
    }

    pendingRequests.set(id, {
      onProgress,
      resolve: onResolve,
      reject: onReject,
    })

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    worker.postMessage(
      {
        ...payload,
        id,
        type: 'match',
      },
      [payload.sourcePixels, payload.targetPixels],
    )
  })
}

const fitImageCover = (ctx, image, width, height) => {
  const imageAspect = image.width / image.height
  const canvasAspect = width / height

  let sourceWidth = image.width
  let sourceHeight = image.height
  let sourceX = 0
  let sourceY = 0

  if (imageAspect > canvasAspect) {
    sourceWidth = image.height * canvasAspect
    sourceX = (image.width - sourceWidth) * 0.5
  } else {
    sourceHeight = image.width / canvasAspect
    sourceY = (image.height - sourceHeight) * 0.5
  }

  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height)
}

const decodeImage = (src) =>
  new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`无法加载图像: ${src}`))
    image.src = src
  })

const rasterizeImage = (image, width, height) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  fitImageCover(ctx, image, width, height)

  return {
    pixels: ctx.getImageData(0, 0, width, height).data,
    dataUrl: canvas.toDataURL('image/png'),
  }
}

const averageColor = (pixels) => {
  let r = 0
  let g = 0
  let b = 0
  let samples = 0

  for (let i = 0; i < pixels.length; i += 4 * 16) {
    r += pixels[i]
    g += pixels[i + 1]
    b += pixels[i + 2]
    samples += 1
  }

  return {
    r: Math.round(r / Math.max(1, samples)),
    g: Math.round(g / Math.max(1, samples)),
    b: Math.round(b / Math.max(1, samples)),
  }
}

const interpolateColor = (start, end, t) => ({
  r: Math.round(start.r + (end.r - start.r) * t),
  g: Math.round(start.g + (end.g - start.g) * t),
  b: Math.round(start.b + (end.b - start.b) * t),
})

const resolveDefaultRenderBudget = (rendererMode) => {
  if (rendererMode === RENDERER_MODE_GRID) return DEFAULT_GRID_CELL_BUDGET
  if (rendererMode === RENDERER_MODE_POLYGON) return DEFAULT_POLYGON_CELL_BUDGET
  return DEFAULT_VORONOI_CELL_BUDGET
}

const resolveRenderBudget = (rendererMode, renderCellBudget) => {
  const defaultBudget = resolveDefaultRenderBudget(rendererMode)
  return Math.max(
    MIN_RENDER_CELL_BUDGET,
    Math.round(Number(renderCellBudget) || defaultBudget),
  )
}

const getRenderFrameState = (grid, rendererMode, maxCells) => {
  if (!grid?.count) {
    return {
      renderData: {
        count: 0,
        indices: new Uint32Array(0),
        fillStyles: [],
      },
      shapeBuffers: null,
      coords: new Float64Array(0),
      polygonPoints: new Float32Array(8),
      sampleOut: { x: 0, y: 0 },
    }
  }

  const budget = resolveRenderBudget(rendererMode, maxCells)
  const normalizedMode = normalizeRendererMode(rendererMode)
  const cacheKey = `${normalizedMode}:${budget}`

  let cacheByBudget = renderFrameStateCache.get(grid)
  if (!cacheByBudget) {
    cacheByBudget = new Map()
    renderFrameStateCache.set(grid, cacheByBudget)
  }

  if (cacheByBudget.has(cacheKey)) {
    return cacheByBudget.get(cacheKey)
  }

  const renderData = getVoronoiRenderData(grid, budget)
  const state = {
    renderData,
    shapeBuffers: normalizedMode === RENDERER_MODE_POLYGON ? getMorphShapeBuffers(grid) : null,
    coords: new Float64Array(renderData.count * 2),
    polygonPoints: new Float32Array(8),
    sampleOut: { x: 0, y: 0 },
  }

  cacheByBudget.set(cacheKey, state)
  return state
}

export const resolveMaxGridCellCount = (width, height) => {
  const targetReferenceSide = Math.max(16, Math.round(Math.min(width, height) || DEFAULT_MORPH_WIDTH))
  const targetReferenceCells = targetReferenceSide * targetReferenceSide
  return clamp(targetReferenceCells, 16 * 16, MAX_GRID_CELLS_AT_100)
}

const resolveMaxGridSideAt100 = (width, height) =>
  Math.max(16, Math.floor(Math.sqrt(resolveMaxGridCellCount(width, height))))

export const resolveCellResolution = (
  width,
  height,
  resolutionPercent,
  maxResolutionPercent = MAX_RESOLUTION_PERCENT,
) => {
  const maxGridSideAt100 = resolveMaxGridSideAt100(width, height)

  const safeMaxPercent = Math.max(
    MIN_RESOLUTION_PERCENT,
    Math.min(
      MAX_RESOLUTION_PERCENT,
      Number.isFinite(Number(maxResolutionPercent)) ? Number(maxResolutionPercent) : MAX_RESOLUTION_PERCENT,
    ),
  )

  const safePercent = clamp(
    Number.isFinite(Number(resolutionPercent)) ? Number(resolutionPercent) : 8,
    MIN_RESOLUTION_PERCENT,
    safeMaxPercent,
  )

  return clamp(
    Math.round(maxGridSideAt100 * (safePercent / 100)),
    16,
    Math.min(MAX_CELL_RESOLUTION, maxGridSideAt100),
  )
}

export const buildMorphData = async (sourceUrl, targetUrl, options = {}) => {
  const {
    width = DEFAULT_MORPH_WIDTH,
    height = DEFAULT_MORPH_HEIGHT,
    resolutionReferenceWidth = width,
    resolutionReferenceHeight = height,
    resolutionPercent = 8,
    maxResolutionPercent = MAX_RESOLUTION_PERCENT,
    simulationFrames = 96,
    proximityFactor = 6.2,
    onProgress,
    signal,
  } = options

  const ensureNotAborted = () => {
    if (signal?.aborted) {
      throw createAbortError()
    }
  }

  ensureNotAborted()

  const safeMaxPercent = Math.max(
    MIN_RESOLUTION_PERCENT,
    Math.min(MAX_RESOLUTION_PERCENT, Number(maxResolutionPercent) || MAX_RESOLUTION_PERCENT),
  )
  const safePercent = clamp(Number(resolutionPercent) || 8, MIN_RESOLUTION_PERCENT, safeMaxPercent)
  const maxGridCellCount = resolveMaxGridCellCount(resolutionReferenceWidth, resolutionReferenceHeight)
  const resolution = resolveCellResolution(
    resolutionReferenceWidth,
    resolutionReferenceHeight,
    safePercent,
    safeMaxPercent,
  )

  onProgress?.('loading', 0)
  const [sourceImage, targetImage] = await Promise.all([
    decodeImage(sourceUrl),
    decodeImage(targetUrl),
  ])
  ensureNotAborted()
  onProgress?.('loading', 1)

  onProgress?.('rasterizing_a', 0)
  const sourceRaster = rasterizeImage(sourceImage, width, height)
  ensureNotAborted()
  onProgress?.('rasterizing_a', 1)

  onProgress?.('rasterizing_b', 0)
  const targetRaster = rasterizeImage(targetImage, width, height)
  ensureNotAborted()
  onProgress?.('rasterizing_b', 1)

  const sourceAverage = averageColor(sourceRaster.pixels)
  const targetAverage = averageColor(targetRaster.pixels)

  onProgress?.('matching_worker', 0)
  const workerResult = await runMatchingWorker(
    {
      sourcePixels: sourceRaster.pixels.buffer,
      targetPixels: targetRaster.pixels.buffer,
      width,
      height,
      resolution,
      proximityFactor,
      simulationFrames,
    },
    (phase, progress) => {
      onProgress?.(phase, progress)
    },
    signal,
  )

  ensureNotAborted()
  onProgress?.('matching_worker', 1)

  onProgress?.('done', 1)

  return {
    width,
    height,
    sourceRasterUrl: sourceRaster.dataUrl,
    targetRasterUrl: targetRaster.dataUrl,
    sourceAverage,
    targetAverage,
    grid: workerResult.grid,
    createdAt: Date.now(),
    meta: {
      resolutionPercent: safePercent,
      maxResolutionPercent: safeMaxPercent,
      maxGridCellCount,
      maxGridSide: Math.floor(Math.sqrt(maxGridCellCount)),
      referenceWidth: Math.max(2, Math.round(Number(resolutionReferenceWidth) || width)),
      referenceHeight: Math.max(2, Math.round(Number(resolutionReferenceHeight) || height)),
      pointCount: workerResult.stats.cellCount,
      cellCount: workerResult.stats.cellCount,
      resolution: workerResult.grid.side,
      proximityFactor,
      simulationFrames,
      generationCount: workerResult.stats.generationCount,
      acceptedSwaps: workerResult.stats.acceptedSwaps,
      weightRange: workerResult.stats.weightRange,
    },
  }
}

const drawGridCells = (ctx, frameState, grid, p, scale, offsetX, offsetY) => {
  const { renderData, sampleOut } = frameState
  const lockToTarget = p >= 0.999
  const sizeProgress = lockToTarget ? 1 : smoothstep(clamp((p - 0.68) / 0.32, 0, 1))

  for (let localIndex = 0; localIndex < renderData.count; localIndex += 1) {
    const sourceIndex = renderData.indices[localIndex]
    const base2 = sourceIndex * 2

    if (lockToTarget) {
      sampleOut.x = grid.targetPositions[base2]
      sampleOut.y = grid.targetPositions[base2 + 1]
    } else {
      sampleCellPosition(grid, sourceIndex, p, sampleOut)
    }

    const boundBase = sourceIndex * 4
    const sourceWidth = grid.cellBounds?.[boundBase + 2] ?? 1
    const sourceHeight = grid.cellBounds?.[boundBase + 3] ?? 1
    const mappedTargetIndex = clamp(Number(grid.sourceToTarget?.[sourceIndex] ?? sourceIndex), 0, grid.count - 1)
    const targetBoundBase = mappedTargetIndex * 4
    const targetWidth = grid.cellBounds?.[targetBoundBase + 2] ?? sourceWidth
    const targetHeight = grid.cellBounds?.[targetBoundBase + 3] ?? sourceHeight

    const drawWidth = (sourceWidth + (targetWidth - sourceWidth) * sizeProgress) * scale
    const drawHeight = (sourceHeight + (targetHeight - sourceHeight) * sizeProgress) * scale
    const drawX = offsetX + sampleOut.x * scale - drawWidth * 0.5
    const drawY = offsetY + sampleOut.y * scale - drawHeight * 0.5

    ctx.fillStyle = renderData.fillStyles[localIndex]
    ctx.fillRect(drawX, drawY, drawWidth, drawHeight)
  }
}

const drawPolygonCells = (ctx, frameState, grid, p, scale, offsetX, offsetY) => {
  const { renderData, shapeBuffers, sampleOut, polygonPoints } = frameState
  if (!shapeBuffers?.count) return

  const lockToTarget = p >= 0.999
  const morphT = lockToTarget ? 1 : p

  for (let localIndex = 0; localIndex < renderData.count; localIndex += 1) {
    const sourceIndex = renderData.indices[localIndex]
    const base2 = sourceIndex * 2

    if (lockToTarget) {
      sampleOut.x = grid.targetPositions[base2]
      sampleOut.y = grid.targetPositions[base2 + 1]
    } else {
      sampleCellPosition(grid, sourceIndex, p, sampleOut)
    }

    interpolateCellPolygon(shapeBuffers, sourceIndex, sampleOut.x, sampleOut.y, morphT, polygonPoints)

    if (!Number.isFinite(polygonPoints[0]) || !Number.isFinite(polygonPoints[1])) continue

    ctx.beginPath()
    ctx.moveTo(offsetX + polygonPoints[0] * scale, offsetY + polygonPoints[1] * scale)

    for (let point = 2; point < 8; point += 2) {
      const px = polygonPoints[point]
      const py = polygonPoints[point + 1]
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue
      ctx.lineTo(offsetX + px * scale, offsetY + py * scale)
    }

    ctx.closePath()
    ctx.fillStyle = renderData.fillStyles[localIndex]
    ctx.fill()
  }
}

const drawVoronoiCells = (ctx, frameState, grid, width, height, p, scale, offsetX, offsetY) => {
  const { renderData, coords, sampleOut } = frameState
  const lockToTarget = p >= 0.999

  for (let localIndex = 0; localIndex < renderData.count; localIndex += 1) {
    const sourceIndex = renderData.indices[localIndex]
    const base2 = sourceIndex * 2

    if (lockToTarget) {
      sampleOut.x = grid.targetPositions[base2]
      sampleOut.y = grid.targetPositions[base2 + 1]
    } else {
      sampleCellPosition(grid, sourceIndex, p, sampleOut)
    }

    const coordBase = localIndex * 2
    coords[coordBase] = sampleOut.x
    coords[coordBase + 1] = sampleOut.y
  }

  const delaunay = new Delaunay(coords)
  const voronoi = delaunay.voronoi([0, 0, width, height])

  for (let localIndex = 0; localIndex < renderData.count; localIndex += 1) {
    const polygon = voronoi.cellPolygon(localIndex)
    if (!polygon || polygon.length < 3) continue

    const [startX, startY] = polygon[0]
    if (!Number.isFinite(startX) || !Number.isFinite(startY)) continue

    let valid = true
    for (let pointIndex = 1; pointIndex < polygon.length; pointIndex += 1) {
      const [px, py] = polygon[pointIndex]
      if (!Number.isFinite(px) || !Number.isFinite(py)) {
        valid = false
        break
      }
    }
    if (!valid) continue

    ctx.beginPath()
    ctx.moveTo(offsetX + startX * scale, offsetY + startY * scale)

    for (let pointIndex = 1; pointIndex < polygon.length; pointIndex += 1) {
      const [px, py] = polygon[pointIndex]
      ctx.lineTo(offsetX + px * scale, offsetY + py * scale)
    }

    ctx.closePath()
    ctx.fillStyle = renderData.fillStyles[localIndex]
    ctx.fill()
  }
}

export const drawMorphFrame = (ctx, morphData, progress, options = {}) => {
  if (!ctx) return

  const width = options.width ?? ctx.canvas.width
  const height = options.height ?? ctx.canvas.height

  ctx.clearRect(0, 0, width, height)

  if (!morphData?.grid) {
    ctx.fillStyle = '#1b2735'
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.88)'
    ctx.font = '500 22px Barlow, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('等待生成重分配动画', width / 2, height / 2)
    return
  }

  const p = clamp(progress, 0, 1)
  const eased = smoothstep(p)
  const scale = Math.min(width / morphData.width, height / morphData.height)
  const drawWidth = morphData.width * scale
  const drawHeight = morphData.height * scale
  const offsetX = (width - drawWidth) * 0.5
  const offsetY = (height - drawHeight) * 0.5

  const bgA = interpolateColor(morphData.sourceAverage, morphData.targetAverage, eased * 0.55)
  const bgB = interpolateColor(morphData.sourceAverage, morphData.targetAverage, 0.32 + eased * 0.68)
  const gradient = ctx.createLinearGradient(0, 0, width, height)
  gradient.addColorStop(0, `rgb(${Math.round(bgA.r * 0.42)}, ${Math.round(bgA.g * 0.42)}, ${Math.round(bgA.b * 0.42)})`)
  gradient.addColorStop(1, `rgb(${Math.round(bgB.r * 0.27)}, ${Math.round(bgB.g * 0.27)}, ${Math.round(bgB.b * 0.27)})`)

  ctx.fillStyle = '#09131f'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)

  const grid = morphData.grid
  const rendererMode = normalizeRendererMode(options.rendererMode ?? DEFAULT_RENDERER_MODE)
  const renderBudget = options.renderCellBudget ?? options.voronoiCellBudget
  const frameState = getRenderFrameState(grid, rendererMode, renderBudget)
  const { renderData } = frameState

  if (!renderData.count) {
    return
  }

  if (rendererMode === RENDERER_MODE_GRID) {
    drawGridCells(ctx, frameState, grid, p, scale, offsetX, offsetY)
    return
  }

  if (rendererMode === RENDERER_MODE_POLYGON) {
    drawPolygonCells(ctx, frameState, grid, p, scale, offsetX, offsetY)
    return
  }

  drawVoronoiCells(ctx, frameState, grid, morphData.width, morphData.height, p, scale, offsetX, offsetY)
}

export const renderMorphThumbnail = (morphData, progress = 0.52, options = {}) => {
  const canvas = document.createElement('canvas')
  canvas.width = 280
  canvas.height = 158
  const ctx = canvas.getContext('2d')
  drawMorphFrame(ctx, morphData, progress, options)
  return canvas.toDataURL('image/png')
}
