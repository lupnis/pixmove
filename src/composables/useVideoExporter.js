import { GIFEncoder, applyPalette, quantize } from 'gifenc'
import { drawMorphFrame } from './useMorphEngine'
import { createPixiMorphRenderer } from './usePixiMorphRenderer'
import { evaluateTimeline } from '../utils/timeline'
import { DEFAULT_RENDERER_MODE, normalizeRendererMode } from '../utils/renderModes'

const resolveRenderCellBudget = (rendererMode, explicitBudget) => {
  if (Number.isFinite(Number(explicitBudget))) {
    return Math.max(128, Math.round(Number(explicitBudget)))
  }

  return undefined
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const createAbortError = () => {
  const error = new Error('Export stopped.')
  error.name = 'AbortError'
  return error
}

const ensureNotAborted = (signal) => {
  if (signal?.aborted) {
    throw createAbortError()
  }
}

const sleepWithSignal = (ms, signal) => {
  if (!signal) return sleep(ms)

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(createAbortError())
      return
    }

    let timer = null

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }

      signal.removeEventListener('abort', onAbort)
    }

    const onAbort = () => {
      cleanup()
      reject(createAbortError())
    }

    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export const downloadBlob = (blob, filename) => {
  const downloadable = blob instanceof Blob
    ? blob
    : new Blob([blob], { type: 'application/octet-stream' })

  const url = URL.createObjectURL(downloadable)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()

  setTimeout(() => {
    anchor.remove()
    URL.revokeObjectURL(url)
  }, 1200)
}

export const sanitizeFilename = (text) =>
  text
    .replace(/[^\w一-龥.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)

export const buildDefaultGifFilename = (date = new Date()) => `pixmove_${date.getTime()}.gif`

const createHiddenHost = (width, height) => {
  const host = document.createElement('div')
  host.style.position = 'fixed'
  host.style.left = '-20000px'
  host.style.top = '0'
  host.style.width = `${Math.round(width)}px`
  host.style.height = `${Math.round(height)}px`
  host.style.opacity = '0'
  host.style.pointerEvents = 'none'
  host.style.overflow = 'hidden'
  host.style.zIndex = '-1'
  document.body.appendChild(host)
  return host
}

const createFrameSurface = (width, height) => {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(2, Math.round(width || 2))
  canvas.height = Math.max(2, Math.round(height || 2))

  const ctx = canvas.getContext('2d', { willReadFrequently: true }) || canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Canvas 2D frame export is not supported in this environment.')
  }

  return { canvas, ctx }
}

const computeMorphProgress = (keyframes, timelineT) =>
  keyframes?.length ? evaluateTimeline(keyframes, timelineT) : timelineT

const encodeGifFrames = async (options = {}) => {
  const {
    width,
    height,
    durationSeconds = 4,
    fps = 24,
    keyframes,
    onProgress,
    signal,
    renderFrame,
  } = options

  ensureNotAborted(signal)

  if (typeof document === 'undefined') {
    throw new Error('GIF export is not supported in this environment.')
  }

  const safeWidth = Math.max(2, Math.round(width || 640))
  const safeHeight = Math.max(2, Math.round(height || 360))
  const safeFps = Math.max(6, Math.round(fps || 24))
  const totalFrames = Math.max(2, Math.round((durationSeconds || 4) * safeFps))
  const delay = Math.max(20, Math.round(1000 / safeFps))
  const { ctx } = createFrameSurface(safeWidth, safeHeight)
  const gif = GIFEncoder()

  for (let frame = 0; frame < totalFrames; frame += 1) {
    ensureNotAborted(signal)

    const timelineT = totalFrames > 1 ? frame / (totalFrames - 1) : 1
    const morphProgress = computeMorphProgress(keyframes, timelineT)

    await renderFrame(ctx, morphProgress, frame, totalFrames)
    ensureNotAborted(signal)

    const rgba = ctx.getImageData(0, 0, safeWidth, safeHeight).data
    onProgress?.('recording', (frame + 0.45) / totalFrames)

    const palette = quantize(rgba, 256)
    const index = applyPalette(rgba, palette)

    gif.writeFrame(index, safeWidth, safeHeight, {
      palette,
      delay,
      repeat: frame === 0 ? 0 : undefined,
    })

    onProgress?.('encoding', (frame + 1) / totalFrames)

    if (frame < totalFrames - 1) {
      await sleepWithSignal(0, signal)
    }
  }

  gif.finish()
  ensureNotAborted(signal)

  return new Blob([gif.bytesView()], { type: 'image/gif' })
}

const exportMorphGif2D = async (morphData, options = {}) => {
  const {
    durationSeconds = 4,
    fps = 24,
    width = morphData.width,
    height = morphData.height,
    rendererMode = DEFAULT_RENDERER_MODE,
    renderCellBudget,
    keyframes,
    onProgress,
    signal,
  } = options

  const normalizedRendererMode = normalizeRendererMode(rendererMode)
  const resolvedCellBudget = resolveRenderCellBudget(normalizedRendererMode, renderCellBudget)

  return encodeGifFrames({
    width,
    height,
    durationSeconds,
    fps,
    keyframes,
    onProgress,
    signal,
    renderFrame: async (ctx, morphProgress) => {
      drawMorphFrame(ctx, morphData, morphProgress, {
        width,
        height,
        rendererMode: normalizedRendererMode,
        ...(Number.isFinite(Number(resolvedCellBudget)) ? { renderCellBudget: resolvedCellBudget } : {}),
      })
    },
  })
}

const exportMorphGifWebGL = async (morphData, options = {}) => {
  const {
    durationSeconds = 4,
    fps = 24,
    width = morphData.width,
    height = morphData.height,
    rendererMode = DEFAULT_RENDERER_MODE,
    renderCellBudget,
    keyframes,
    onProgress,
    signal,
  } = options

  const normalizedRendererMode = normalizeRendererMode(rendererMode)
  const resolvedCellBudget = resolveRenderCellBudget(normalizedRendererMode, renderCellBudget)

  ensureNotAborted(signal)

  if (typeof document === 'undefined' || !document.body) {
    throw new Error('Offscreen WebGL export is not supported in this environment.')
  }

  const host = createHiddenHost(width, height)
  let renderer = null

  try {
    onProgress?.('recording_webgl_setup', 0.1)

    renderer = await createPixiMorphRenderer(host, {
      width,
      height,
      manualRender: true,
      resolution: 1,
      rendererMode: normalizedRendererMode,
      ...(Number.isFinite(Number(resolvedCellBudget)) ? { renderCellBudget: resolvedCellBudget } : {}),
    })

    await renderer.setMorphData(morphData)
    ensureNotAborted(signal)
    renderer.setProgress(0)
    renderer.renderFrame()

    return await encodeGifFrames({
      width,
      height,
      durationSeconds,
      fps,
      keyframes,
      onProgress,
      signal,
      renderFrame: async (ctx, morphProgress) => {
        renderer.setProgress(morphProgress)
        renderer.renderFrame()
        ctx.clearRect(0, 0, width, height)
        ctx.drawImage(renderer.canvas, 0, 0, width, height)
      },
    })
  } finally {
    renderer?.destroy()
    host.remove()
  }
}

export const exportMorphAsGif = async (morphData, options = {}) => {
  const {
    renderBackend = 'webgl',
    allow2DFallback = true,
    onProgress,
    signal,
  } = options

  ensureNotAborted(signal)

  if (renderBackend === '2d') {
    return exportMorphGif2D(morphData, options)
  }

  try {
    return await exportMorphGifWebGL(morphData, options)
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw error
    }

    if (!allow2DFallback) {
      throw error
    }

    onProgress?.('recording_webgl_fallback', 0)
    return exportMorphGif2D(morphData, options)
  }
}
