import { Delaunay } from 'd3-delaunay'
import { clamp, sampleCellPosition, smoothstep } from '../utils/morphPlayback'
import { getMorphShapeBuffers, interpolateCellPolygon } from '../utils/morphPolygons'
import { getVoronoiRenderData } from '../utils/morphVoronoi'
import { getGridFlowRenderState } from '../utils/gridFlow'
import { createJamRenderState, sampleJamCenters } from '../utils/morphJam'
import {
  DEFAULT_RENDERER_MODE,
  normalizeRendererMode,
  RENDERER_MODE_GRID,
  RENDERER_MODE_GRID_FLOW,
  RENDERER_MODE_JAM,
  RENDERER_MODE_POLYGON,
  RENDERER_MODE_VORONOI,
} from '../utils/renderModes'

export {
  DEFAULT_RENDERER_MODE,
  normalizeRendererMode,
  RENDERER_MODE_GRID,
  RENDERER_MODE_GRID_FLOW,
  RENDERER_MODE_JAM,
  RENDERER_MODE_POLYGON,
  RENDERER_MODE_VORONOI,
} from '../utils/renderModes'

export const DEFAULT_MORPH_WIDTH = 480
export const DEFAULT_MORPH_HEIGHT = 480
export const MIN_RESOLUTION_PERCENT = 4
export const MAX_RESOLUTION_PERCENT = 100

const MIN_RENDER_CELL_BUDGET = 128
const DEFAULT_GRID_CELL_BUDGET = 4200
const DEFAULT_POLYGON_CELL_BUDGET = 3200
const DEFAULT_JAM_CELL_BUDGET = 4800
const DEFAULT_VORONOI_CELL_BUDGET = 7200

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

const resolveRevealProgress = (progress) =>
  smoothstep(clamp((Number(progress) - 0.01) / 0.22, 0, 1))

const resolveGridFlowMotionProgress = (progress, sourceOverlayActive) => {
  const p = clamp(Number(progress) || 0, 0, 1)
  if (!sourceOverlayActive) return p

  // Keep grid-flow blocks static until source overlay has fully faded out.
  const motionStart = 0.32
  if (p <= motionStart) return 0

  return clamp((p - motionStart) / (1 - motionStart), 0, 1)
}

const resolveSourceOverlayAlpha = (progress) => {
  const p = clamp(progress, 0, 1)
  const revealProgress = resolveRevealProgress(p)

  if (revealProgress < 0.995) {
    return 1
  }

  const fadeAfterReveal = smoothstep(clamp((p - 0.24) / 0.08, 0, 1))
  return Math.max(0, 1 - fadeAfterReveal)
}

const resolveRevealHash = (sourceIndex) => {
  const seed = (Math.imul((sourceIndex + 1) ^ 0x9e3779b9, 2654435761) >>> 0)
  return seed / 4294967295
}

const isSourceRevealed = (sourceIndex, revealProgress) =>
  revealProgress >= 0.999 || resolveRevealHash(sourceIndex) <= revealProgress

const resolveDefaultRenderBudget = (rendererMode) => {
  if (rendererMode === RENDERER_MODE_GRID || rendererMode === RENDERER_MODE_GRID_FLOW) return DEFAULT_GRID_CELL_BUDGET
  if (rendererMode === RENDERER_MODE_POLYGON) return DEFAULT_POLYGON_CELL_BUDGET
  if (rendererMode === RENDERER_MODE_JAM) return DEFAULT_JAM_CELL_BUDGET
  return DEFAULT_VORONOI_CELL_BUDGET
}

const resolveRenderBudget = (rendererMode, renderCellBudget) => {
  const defaultBudget = resolveDefaultRenderBudget(rendererMode)
  return Math.max(
    MIN_RENDER_CELL_BUDGET,
    Math.round(Number(renderCellBudget) || defaultBudget),
  )
}

const resolveModeBudget = (grid, rendererMode, renderCellBudget) => {
  const totalCount = Number(grid?.count) || 0
  if (!totalCount) return 0

  const normalizedMode = normalizeRendererMode(rendererMode)

  if (
    normalizedMode === RENDERER_MODE_GRID
    || normalizedMode === RENDERER_MODE_GRID_FLOW
    || normalizedMode === RENDERER_MODE_POLYGON
  ) {
    return totalCount
  }

  if (normalizedMode === RENDERER_MODE_JAM) {
    return Math.min(totalCount, resolveRenderBudget(normalizedMode, renderCellBudget))
  }

  const hasExplicitBudget = Number.isFinite(Number(renderCellBudget))
  if (!hasExplicitBudget) {
    return totalCount
  }

  return resolveRenderBudget(normalizedMode, renderCellBudget)
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
      gridFlowState: null,
      jamState: null,
      coords: new Float64Array(0),
      polygonPoints: new Float32Array(8),
      sampleOut: { x: 0, y: 0 },
    }
  }

  const budget = resolveModeBudget(grid, rendererMode, maxCells)
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
  const gridFlowState = normalizedMode === RENDERER_MODE_GRID_FLOW ? getGridFlowRenderState(grid) : null
  const jamState = normalizedMode === RENDERER_MODE_JAM ? createJamRenderState(grid, renderData) : null
  const state = {
    renderData,
    shapeBuffers: normalizedMode === RENDERER_MODE_POLYGON ? getMorphShapeBuffers(grid) : null,
    gridFlowState,
    jamState,
    flowSmoothX: gridFlowState ? new Float32Array(gridFlowState.count) : null,
    flowSmoothY: gridFlowState ? new Float32Array(gridFlowState.count) : null,
    flowSmoothInitialized: false,
    flowLastProgress: -1,
    coords: new Float64Array(renderData.count * 2),
    polygonPoints: new Float32Array(8),
    sampleOut: { x: 0, y: 0 },
  }

  cacheByBudget.set(cacheKey, state)
  return state
}

export const resolveMaxGridCellCount = (width, height) =>
  Math.max(1, Math.round(Number(width) || DEFAULT_MORPH_WIDTH))
  * Math.max(1, Math.round(Number(height) || DEFAULT_MORPH_HEIGHT))

export const resolveCellResolution = (
  width,
  height,
  resolutionPercent,
  maxResolutionPercent = MAX_RESOLUTION_PERCENT,
) => {
  const safeWidth = Math.max(1, Math.round(Number(width) || DEFAULT_MORPH_WIDTH))
  const safeHeight = Math.max(1, Math.round(Number(height) || DEFAULT_MORPH_HEIGHT))

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

  const columns = clamp(
    Math.round(safeWidth * (safePercent / 100)),
    1,
    safeWidth,
  )
  const rows = clamp(
    Math.round(safeHeight * (safePercent / 100)),
    1,
    safeHeight,
  )

  return {
    width: columns,
    height: rows,
    count: columns * rows,
  }
}

export const buildMorphData = async (sourceUrl, targetUrl, options = {}) => {
  const {
    width,
    height,
    resolutionReferenceWidth = width,
    resolutionReferenceHeight = height,
    resolutionPercent = 8,
    maxResolutionPercent = MAX_RESOLUTION_PERCENT,
    simulationFrames = 96,
    proximityFactor = 8.4,
    onProgress,
    signal,
  } = options

  const ensureNotAborted = () => {
    if (signal?.aborted) {
      throw createAbortError()
    }
  }

  ensureNotAborted()

  const rasterWidth = Math.max(2, Math.round(Number(width) || Number(resolutionReferenceWidth) || DEFAULT_MORPH_WIDTH))
  const rasterHeight = Math.max(2, Math.round(Number(height) || Number(resolutionReferenceHeight) || DEFAULT_MORPH_HEIGHT))
  const safeReferenceWidth = Math.max(2, Math.round(Number(resolutionReferenceWidth) || rasterWidth))
  const safeReferenceHeight = Math.max(2, Math.round(Number(resolutionReferenceHeight) || rasterHeight))
  const safeMaxPercent = Math.max(
    MIN_RESOLUTION_PERCENT,
    Math.min(MAX_RESOLUTION_PERCENT, Number(maxResolutionPercent) || MAX_RESOLUTION_PERCENT),
  )
  const safePercent = clamp(Number(resolutionPercent) || 8, MIN_RESOLUTION_PERCENT, safeMaxPercent)
  const maxGridCellCount = resolveMaxGridCellCount(safeReferenceWidth, safeReferenceHeight)
  const resolution = resolveCellResolution(
    safeReferenceWidth,
    safeReferenceHeight,
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
  const sourceRaster = rasterizeImage(sourceImage, rasterWidth, rasterHeight)
  ensureNotAborted()
  onProgress?.('rasterizing_a', 1)

  onProgress?.('rasterizing_b', 0)
  const targetRaster = rasterizeImage(targetImage, rasterWidth, rasterHeight)
  ensureNotAborted()
  onProgress?.('rasterizing_b', 1)

  const sourceAverage = averageColor(sourceRaster.pixels)
  const targetAverage = averageColor(targetRaster.pixels)

  onProgress?.('matching_worker', 0)
  const workerResult = await runMatchingWorker(
    {
      sourcePixels: sourceRaster.pixels.buffer,
      targetPixels: targetRaster.pixels.buffer,
      width: rasterWidth,
      height: rasterHeight,
      gridWidth: resolution.width,
      gridHeight: resolution.height,
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
    width: rasterWidth,
    height: rasterHeight,
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
      maxGridWidth: safeReferenceWidth,
      maxGridHeight: safeReferenceHeight,
      referenceWidth: safeReferenceWidth,
      referenceHeight: safeReferenceHeight,
      pointCount: workerResult.stats.cellCount,
      cellCount: workerResult.stats.cellCount,
      resolution: workerResult.grid.columns,
      resolutionWidth: workerResult.grid.columns,
      resolutionHeight: workerResult.grid.rows,
      proximityFactor,
      simulationFrames,
      generationCount: workerResult.stats.generationCount,
      acceptedSwaps: workerResult.stats.acceptedSwaps,
      weightRange: workerResult.stats.weightRange,
    },
  }
}

const drawGridCells = (ctx, frameState, grid, p, scale, offsetX, offsetY, revealProgress = 1) => {
  const { renderData, sampleOut } = frameState
  const tailBlend = smoothstep(clamp((p - 0.82) / 0.18, 0, 1))
  const motionT = p
  const sizeProgress = p
  const overlapPxBase = 1.85 + (2.45 - 1.85) * tailBlend
  const overlapWorldBase = overlapPxBase / Math.max(0.0001, scale)
  const samplePrevOut = { x: 0, y: 0 }
  const motionStep = clamp(2 / Math.max(2, Number(grid?.frameCount) || 96), 0.006, 0.03)
  const motionBoost = 1 - tailBlend * 0.88

  for (let localIndex = 0; localIndex < renderData.count; localIndex += 1) {
    const sourceIndex = renderData.indices[localIndex]
    if (!isSourceRevealed(sourceIndex, revealProgress)) continue
    sampleCellPosition(grid, sourceIndex, motionT, sampleOut)

    let motionDistance = 0
    if (motionT > 0) {
      const previousT = Math.max(0, motionT - motionStep)
      sampleCellPosition(grid, sourceIndex, previousT, samplePrevOut)
      motionDistance = Math.hypot(sampleOut.x - samplePrevOut.x, sampleOut.y - samplePrevOut.y)
    }

    const motionOverlapWorld = Math.min(4 / Math.max(0.0001, scale), motionDistance * 0.55 * motionBoost)
    const overlapWorld = overlapWorldBase + motionOverlapWorld
    const strokeWidth = Math.max(
      1,
      overlapPxBase * 1.2 + Math.min(3.0, motionDistance * scale * 0.42 * motionBoost),
    )

    const boundBase = sourceIndex * 4
    const sourceWidth = grid.cellBounds?.[boundBase + 2] ?? 1
    const sourceHeight = grid.cellBounds?.[boundBase + 3] ?? 1
    const mappedTargetIndex = clamp(Number(grid.sourceToTarget?.[sourceIndex] ?? sourceIndex), 0, grid.count - 1)
    const targetBoundBase = mappedTargetIndex * 4
    const targetWidth = grid.cellBounds?.[targetBoundBase + 2] ?? sourceWidth
    const targetHeight = grid.cellBounds?.[targetBoundBase + 3] ?? sourceHeight

    const drawWidth = ((sourceWidth + (targetWidth - sourceWidth) * sizeProgress) + overlapWorld * 2) * scale
    const drawHeight = ((sourceHeight + (targetHeight - sourceHeight) * sizeProgress) + overlapWorld * 2) * scale
    const drawX = offsetX + sampleOut.x * scale - drawWidth * 0.5
    const drawY = offsetY + sampleOut.y * scale - drawHeight * 0.5

    ctx.fillStyle = renderData.fillStyles[localIndex]
    ctx.fillRect(drawX, drawY, drawWidth, drawHeight)
    ctx.lineWidth = strokeWidth
    ctx.strokeStyle = renderData.fillStyles[localIndex]
    ctx.strokeRect(drawX, drawY, drawWidth, drawHeight)
  }
}

const drawGridFlowCells = (ctx, frameState, grid, p, scale, offsetX, offsetY, revealProgress = 1) => {
  const flowState = frameState.gridFlowState
  if (!flowState?.count || !flowState.sourceCellByFrame?.length) return
  if (!frameState.flowSmoothX || !frameState.flowSmoothY) return

  const count = flowState.count
  const frameCount = Math.max(2, flowState.frameCount || 2)
  const frameProgress = clamp(p, 0, 1) * (frameCount - 1)
  const frameA = Math.floor(frameProgress)
  const frameB = Math.min(frameCount - 1, frameA + 1)
  const localT = frameProgress - frameA
  const offsetA = frameA * count
  const offsetB = frameB * count
  const tailBlend = smoothstep(clamp((p - 0.8) / 0.2, 0, 1))
  const overlapPxBase = 2.8 + (3.5 - 2.8) * tailBlend
  const resetSmoothing = !frameState.flowSmoothInitialized || p < frameState.flowLastProgress - 0.0001
  const forceTarget = p >= 1
  const progressDelta = resetSmoothing ? 0 : Math.max(0, p - frameState.flowLastProgress)
  const virtualFrameSpan = progressDelta * Math.max(1, frameCount - 1)
  const stepBudgetPx = forceTarget
    ? Number.POSITIVE_INFINITY
    : Math.max(0.15, virtualFrameSpan)
  const maxStepWorld = stepBudgetPx / Math.max(0.0001, scale)
  const smoothX = frameState.flowSmoothX
  const smoothY = frameState.flowSmoothY

  for (let sourceIndex = 0; sourceIndex < count; sourceIndex += 1) {
    const cellA = flowState.sourceCellByFrame[offsetA + sourceIndex]
    const cellB = flowState.sourceCellByFrame[offsetB + sourceIndex]

    const baseA = cellA * 4
    const baseB = cellB * 4

    const cellAX = grid.cellBounds?.[baseA] ?? 0
    const cellAY = grid.cellBounds?.[baseA + 1] ?? 0
    const cellAW = Math.max(1, grid.cellBounds?.[baseA + 2] ?? 1)
    const cellAH = Math.max(1, grid.cellBounds?.[baseA + 3] ?? 1)

    const cellBX = grid.cellBounds?.[baseB] ?? cellAX
    const cellBY = grid.cellBounds?.[baseB + 1] ?? cellAY
    const cellBW = Math.max(1, grid.cellBounds?.[baseB + 2] ?? cellAW)
    const cellBH = Math.max(1, grid.cellBounds?.[baseB + 3] ?? cellAH)

    const centerAX = cellAX + cellAW * 0.5
    const centerAY = cellAY + cellAH * 0.5
    const centerBX = cellBX + cellBW * 0.5
    const centerBY = cellBY + cellBH * 0.5

    const targetCenterX = centerAX + (centerBX - centerAX) * localT
    const targetCenterY = centerAY + (centerBY - centerAY) * localT

    if (resetSmoothing || forceTarget) {
      smoothX[sourceIndex] = targetCenterX
      smoothY[sourceIndex] = targetCenterY
    } else {
      const deltaX = targetCenterX - smoothX[sourceIndex]
      const deltaY = targetCenterY - smoothY[sourceIndex]
      const deltaLength = Math.hypot(deltaX, deltaY)

      if (deltaLength > maxStepWorld) {
        const ratio = maxStepWorld / deltaLength
        smoothX[sourceIndex] += deltaX * ratio
        smoothY[sourceIndex] += deltaY * ratio
      } else {
        smoothX[sourceIndex] = targetCenterX
        smoothY[sourceIndex] = targetCenterY
      }
    }

    const centerX = smoothX[sourceIndex]
    const centerY = smoothY[sourceIndex]

    if (!isSourceRevealed(sourceIndex, revealProgress)) continue

    const overlapWorld = overlapPxBase / Math.max(0.0001, scale)
    const strokeWidth = Math.max(1, overlapPxBase * 1.2)

    const drawWidth = (Math.max(cellAW, cellBW) + overlapWorld * 2) * scale
    const drawHeight = (Math.max(cellAH, cellBH) + overlapWorld * 2) * scale
    const drawX = offsetX + centerX * scale - drawWidth * 0.5
    const drawY = offsetY + centerY * scale - drawHeight * 0.5

    ctx.fillStyle = flowState.fillStyles[sourceIndex]
    ctx.fillRect(drawX, drawY, drawWidth, drawHeight)
    ctx.lineWidth = strokeWidth
    ctx.strokeStyle = flowState.fillStyles[sourceIndex]
    ctx.strokeRect(drawX, drawY, drawWidth, drawHeight)
  }

  frameState.flowSmoothInitialized = true
  frameState.flowLastProgress = p
}

const expandPolygonForOverlap = (points, centerX, centerY, radialScale, overlapWorld) => {
  for (let point = 0; point < 8; point += 2) {
    const dx = points[point] - centerX
    const dy = points[point + 1] - centerY
    const length = Math.hypot(dx, dy)

    if (!Number.isFinite(length) || length < 0.0001) {
      continue
    }

    const targetLength = length * radialScale + overlapWorld
    const ratio = targetLength / length

    points[point] = centerX + dx * ratio
    points[point + 1] = centerY + dy * ratio
  }
}

const drawPolygonCells = (ctx, frameState, grid, p, scale, offsetX, offsetY, revealProgress = 1) => {
  const { renderData, shapeBuffers, sampleOut, polygonPoints } = frameState
  if (!shapeBuffers?.count) return

  const tailBlend = smoothstep(clamp((p - 0.82) / 0.18, 0, 1))
  const motionT = p
  const morphT = p
  const radialScaleBase = 1.07 + (1.05 - 1.07) * tailBlend
  const overlapPxBase = 2.1 + (2.85 - 2.1) * tailBlend
  const overlapWorldBase = overlapPxBase / Math.max(0.0001, scale)
  const samplePrevOut = { x: 0, y: 0 }
  const motionStep = clamp(2 / Math.max(2, Number(grid?.frameCount) || 96), 0.006, 0.03)
  const motionBoost = 1 - tailBlend * 0.88
  const prevJoin = ctx.lineJoin
  const prevMiterLimit = ctx.miterLimit

  ctx.lineJoin = 'round'
  ctx.miterLimit = 2

  for (let localIndex = 0; localIndex < renderData.count; localIndex += 1) {
    const sourceIndex = renderData.indices[localIndex]
    if (!isSourceRevealed(sourceIndex, revealProgress)) continue
    sampleCellPosition(grid, sourceIndex, motionT, sampleOut)

    let motionDistance = 0
    if (motionT > 0) {
      const previousT = Math.max(0, motionT - motionStep)
      sampleCellPosition(grid, sourceIndex, previousT, samplePrevOut)
      motionDistance = Math.hypot(sampleOut.x - samplePrevOut.x, sampleOut.y - samplePrevOut.y)
    }

    const motionOverlapWorld = Math.min(
      4 / Math.max(0.0001, scale),
      motionDistance * 0.55 * motionBoost,
    )
    const overlapWorld = overlapWorldBase + motionOverlapWorld
    const radialScale = radialScaleBase + Math.min(0.2, motionDistance * 0.03 * motionBoost)
    const strokeWidth = Math.max(
      1,
      overlapPxBase * 1.25 + Math.min(3.2, motionDistance * scale * 0.45 * motionBoost),
    )

    interpolateCellPolygon(shapeBuffers, sourceIndex, sampleOut.x, sampleOut.y, morphT, polygonPoints)

    expandPolygonForOverlap(polygonPoints, sampleOut.x, sampleOut.y, radialScale, overlapWorld)

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
    ctx.lineWidth = strokeWidth
    ctx.strokeStyle = renderData.fillStyles[localIndex]
    ctx.stroke()
  }

  ctx.lineJoin = prevJoin
  ctx.miterLimit = prevMiterLimit
}

const drawJamCells = (ctx, frameState, grid, width, height, p, scale, offsetX, offsetY, revealProgress = 1) => {
  const { renderData, coords, jamState, sampleOut } = frameState
  if (!jamState?.count || !coords?.length) return

  if (revealProgress <= 0.001) return

  sampleJamCenters(grid, jamState, p, coords, sampleOut, width, height)

  const delaunay = new Delaunay(coords)
  const voronoi = delaunay.voronoi([0, 0, width, height])
  const edgeBlend = smoothstep(clamp((p - 0.22) / 0.46, 0, 1))
  const strokeWidth = 0.5 + edgeBlend * 0.34
  const prevJoin = ctx.lineJoin
  const prevMiterLimit = ctx.miterLimit

  ctx.lineJoin = 'round'
  ctx.miterLimit = 2

  for (let localIndex = 0; localIndex < renderData.count; localIndex += 1) {
    const sourceIndex = renderData.indices[localIndex]
    if (!isSourceRevealed(sourceIndex, revealProgress)) continue

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
    ctx.lineWidth = strokeWidth
    ctx.strokeStyle = renderData.fillStyles[localIndex]
    ctx.stroke()
  }

  ctx.lineJoin = prevJoin
  ctx.miterLimit = prevMiterLimit
}

const drawVoronoiCells = (ctx, frameState, grid, width, height, p, scale, offsetX, offsetY, revealProgress = 1) => {
  const { renderData, coords, sampleOut } = frameState

  for (let localIndex = 0; localIndex < renderData.count; localIndex += 1) {
    const sourceIndex = renderData.indices[localIndex]

    sampleCellPosition(grid, sourceIndex, p, sampleOut)

    const coordBase = localIndex * 2
    coords[coordBase] = clamp(sampleOut.x, 0, width)
    coords[coordBase + 1] = clamp(sampleOut.y, 0, height)
  }

  const delaunay = new Delaunay(coords)
  const voronoi = delaunay.voronoi([0, 0, width, height])

  for (let localIndex = 0; localIndex < renderData.count; localIndex += 1) {
    const sourceIndex = renderData.indices[localIndex]
    if (!isSourceRevealed(sourceIndex, revealProgress)) continue

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

  const sourceOverlayEnabled = Boolean(options.sourceOverlayEnabled)
  const sourceOverlayImage = options.sourceOverlayImage
  const sourceOverlayActive = sourceOverlayEnabled && Boolean(sourceOverlayImage)

  if (sourceOverlayActive) {
    const sourceOverlayAlpha = resolveSourceOverlayAlpha(p)

    if (sourceOverlayAlpha > 0.001) {
      ctx.save()
      ctx.globalAlpha = sourceOverlayAlpha
      ctx.drawImage(sourceOverlayImage, offsetX, offsetY, drawWidth, drawHeight)
      ctx.restore()
    }
  }

  const revealProgress = sourceOverlayActive ? resolveRevealProgress(p) : 1
  const gridFlowMotionProgress = resolveGridFlowMotionProgress(p, sourceOverlayActive)

  const grid = morphData.grid
  const rendererMode = normalizeRendererMode(options.rendererMode ?? DEFAULT_RENDERER_MODE)
  const renderBudget = options.renderCellBudget ?? options.voronoiCellBudget
  const frameState = getRenderFrameState(grid, rendererMode, renderBudget)
  const { renderData } = frameState

  if (!renderData.count) {
    return
  }

  if (rendererMode === RENDERER_MODE_GRID) {
    drawGridCells(ctx, frameState, grid, p, scale, offsetX, offsetY, revealProgress)
    return
  }

  if (rendererMode === RENDERER_MODE_GRID_FLOW) {
    drawGridFlowCells(
      ctx,
      frameState,
      grid,
      gridFlowMotionProgress,
      scale,
      offsetX,
      offsetY,
      revealProgress,
    )
    return
  }

  if (rendererMode === RENDERER_MODE_JAM) {
    drawJamCells(
      ctx,
      frameState,
      grid,
      morphData.width,
      morphData.height,
      p,
      scale,
      offsetX,
      offsetY,
      revealProgress,
    )
    return
  }

  if (rendererMode === RENDERER_MODE_POLYGON) {
    drawPolygonCells(ctx, frameState, grid, p, scale, offsetX, offsetY, revealProgress)
    return
  }

  drawVoronoiCells(
    ctx,
    frameState,
    grid,
    morphData.width,
    morphData.height,
    p,
    scale,
    offsetX,
    offsetY,
    revealProgress,
  )
}

export const renderMorphThumbnail = (morphData, progress = 0.52, options = {}) => {
  const canvas = document.createElement('canvas')
  canvas.width = 280
  canvas.height = 158
  const ctx = canvas.getContext('2d')
  drawMorphFrame(ctx, morphData, progress, options)
  return canvas.toDataURL('image/png')
}
