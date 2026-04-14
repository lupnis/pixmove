import { clamp, sampleCellPosition, smoothstep } from '../utils/morphPlayback'

export const DEFAULT_MORPH_WIDTH = 480
export const DEFAULT_MORPH_HEIGHT = 480
export const MIN_RESOLUTION_PERCENT = 4
export const MAX_RESOLUTION_PERCENT = 12
export const MAX_CELL_RESOLUTION = 160

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

export const resolveCellResolution = (
  width,
  height,
  resolutionPercent,
  maxResolutionPercent = MAX_RESOLUTION_PERCENT,
) => {
  const safeMaxPercent = Math.max(
    MIN_RESOLUTION_PERCENT,
    Number.isFinite(Number(maxResolutionPercent)) ? Number(maxResolutionPercent) : MAX_RESOLUTION_PERCENT,
  )

  const safePercent = clamp(
    Number.isFinite(Number(resolutionPercent)) ? Number(resolutionPercent) : 8,
    MIN_RESOLUTION_PERCENT,
    safeMaxPercent,
  )

  const baseSize = Math.min(width, height)
  return clamp(Math.round(baseSize * (safePercent / 100)), 16, Math.min(MAX_CELL_RESOLUTION, baseSize))
}

export const buildMorphData = async (sourceUrl, targetUrl, options = {}) => {
  const {
    width = DEFAULT_MORPH_WIDTH,
    height = DEFAULT_MORPH_HEIGHT,
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

  const safeMaxPercent = Math.max(MIN_RESOLUTION_PERCENT, Number(maxResolutionPercent) || MAX_RESOLUTION_PERCENT)
  const safePercent = clamp(Number(resolutionPercent) || 8, MIN_RESOLUTION_PERCENT, safeMaxPercent)
  const resolution = resolveCellResolution(width, height, safePercent, safeMaxPercent)

  onProgress?.('loading', 0.06)
  const [sourceImage, targetImage] = await Promise.all([
    decodeImage(sourceUrl),
    decodeImage(targetUrl),
  ])
  ensureNotAborted()

  onProgress?.('rasterizing_a', 0.16)
  const sourceRaster = rasterizeImage(sourceImage, width, height)
  ensureNotAborted()

  onProgress?.('rasterizing_b', 0.24)
  const targetRaster = rasterizeImage(targetImage, width, height)
  ensureNotAborted()

  const sourceAverage = averageColor(sourceRaster.pixels)
  const targetAverage = averageColor(targetRaster.pixels)

  onProgress?.('matching_worker', 0.3)
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

  const position = { x: 0, y: 0 }
  const grid = morphData.grid
  const bounds = grid.cellBounds
  const colors = grid.sourceColors
  const sourceToTarget = grid.sourceToTarget
  const lockToTarget = p >= 0.999
  const sizeProgress = lockToTarget ? 1 : smoothstep(clamp((p - 0.68) / 0.32, 0, 1))

  for (let index = 0; index < grid.count; index += 1) {
    if (lockToTarget) {
      const base2 = index * 2
      position.x = grid.targetPositions[base2]
      position.y = grid.targetPositions[base2 + 1]
    } else {
      sampleCellPosition(grid, index, p, position)
    }

    const boundBase = index * 4
    const colorBase = index * 4
    const drawX = offsetX + position.x * scale
    const drawY = offsetY + position.y * scale
    const sourceWidth = bounds[boundBase + 2] * scale
    const sourceHeight = bounds[boundBase + 3] * scale
    const mappedTargetIndex = sourceToTarget?.[index]
    const safeTargetIndex = clamp(Number(mappedTargetIndex ?? index), 0, grid.count - 1)
    const targetBase = safeTargetIndex * 4
    const targetWidth = bounds[targetBase + 2] * scale
    const targetHeight = bounds[targetBase + 3] * scale
    const cellWidth = sourceWidth + (targetWidth - sourceWidth) * sizeProgress
    const cellHeight = sourceHeight + (targetHeight - sourceHeight) * sizeProgress
    const alpha = clamp(colors[colorBase + 3] / 255, 0.16, 1)

    ctx.fillStyle = `rgba(${colors[colorBase]}, ${colors[colorBase + 1]}, ${colors[colorBase + 2]}, ${alpha})`
    ctx.fillRect(drawX - cellWidth * 0.5, drawY - cellHeight * 0.5, cellWidth, cellHeight)
  }
}

export const renderMorphThumbnail = (morphData, progress = 0.52) => {
  const canvas = document.createElement('canvas')
  canvas.width = 280
  canvas.height = 158
  const ctx = canvas.getContext('2d')
  drawMorphFrame(ctx, morphData, progress)
  return canvas.toDataURL('image/png')
}
