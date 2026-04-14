import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js'
import { Delaunay } from 'd3-delaunay'
import { clamp, sampleCellPosition, smoothstep } from '../utils/morphPlayback'
import { getMorphShapeBuffers, interpolateCellPolygon } from '../utils/morphPolygons'
import { getVoronoiFrameSample, getVoronoiRenderData } from '../utils/morphVoronoi'
import {
  DEFAULT_RENDERER_MODE,
  normalizeRendererMode,
  RENDERER_MODE_GRID,
  RENDERER_MODE_POLYGON,
  RENDERER_MODE_VORONOI,
} from '../utils/renderModes'

const MIN_RENDER_CELL_BUDGET = 128
const DEFAULT_PREVIEW_GRID_CELLS = 4200
const DEFAULT_PREVIEW_POLYGON_CELLS = 3200
const DEFAULT_PREVIEW_VORONOI_CELLS = 2600
const DEFAULT_EXPORT_GRID_CELLS = 5200
const DEFAULT_EXPORT_POLYGON_CELLS = 4200
const DEFAULT_EXPORT_VORONOI_CELLS = 4600

const fitContent = (content, width, height, screenWidth, screenHeight) => {
  if (!content || !width || !height) return

  const scale = Math.min(screenWidth / width, screenHeight / height)
  const drawWidth = width * scale
  const drawHeight = height * scale

  content.scale.set(scale, scale)
  content.position.set((screenWidth - drawWidth) * 0.5, (screenHeight - drawHeight) * 0.5)
}

const resolveInitOptions = (host, options) => {
  const {
    width,
    height,
    manualRender = false,
    resolution,
  } = options

  const initOptions = {
    preference: 'webgl',
    antialias: false,
    autoDensity: true,
    backgroundAlpha: 0,
  }

  if (typeof resolution === 'number' && resolution > 0) {
    initOptions.resolution = resolution
  }

  if (manualRender) {
    initOptions.autoStart = false
    initOptions.sharedTicker = false
    initOptions.width = Math.max(2, Math.round(width || host?.clientWidth || 640))
    initOptions.height = Math.max(2, Math.round(height || host?.clientHeight || 360))
  } else if (width && height) {
    initOptions.width = Math.max(2, Math.round(width))
    initOptions.height = Math.max(2, Math.round(height))
  } else if (host) {
    initOptions.resizeTo = host
  }

  return initOptions
}

const loadImageElement = (src) =>
  new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`无法加载渲染纹理: ${src.slice(0, 32)}...`))
    image.src = src
  })

const resolveDefaultCellBudget = (rendererMode, manualRender) => {
  if (rendererMode === RENDERER_MODE_GRID) {
    return manualRender ? DEFAULT_EXPORT_GRID_CELLS : DEFAULT_PREVIEW_GRID_CELLS
  }

  if (rendererMode === RENDERER_MODE_POLYGON) {
    return manualRender ? DEFAULT_EXPORT_POLYGON_CELLS : DEFAULT_PREVIEW_POLYGON_CELLS
  }

  return manualRender ? DEFAULT_EXPORT_VORONOI_CELLS : DEFAULT_PREVIEW_VORONOI_CELLS
}

const resolveCellBudget = (rendererMode, manualRender, rawBudget) => {
  const defaultBudget = resolveDefaultCellBudget(rendererMode, manualRender)
  return Math.max(MIN_RENDER_CELL_BUDGET, Math.round(Number(rawBudget) || defaultBudget))
}

export const createPixiMorphRenderer = async (host, options = {}) => {
  const app = new Application()
  const manualRender = Boolean(options.manualRender)
  const useRenderWorker = !manualRender
    && options.useRenderWorker !== false
    && typeof Worker !== 'undefined'
  let rendererMode = normalizeRendererMode(options.rendererMode ?? DEFAULT_RENDERER_MODE)
  let renderCellBudget = resolveCellBudget(
    rendererMode,
    manualRender,
    options.renderCellBudget ?? options.voronoiCellBudget,
  )

  await app.init(resolveInitOptions(host, options))

  if (host) {
    host.innerHTML = ''
    host.appendChild(app.canvas)
  }

  const root = new Container()
  const content = new Container()
  const polygonLayer = new Graphics()

  content.addChild(polygonLayer)
  root.addChild(content)
  app.stage.addChild(root)

  const sampleOut = { x: 0, y: 0 }
  const polygonPoints = new Float32Array(8)

  let renderData = null
  let shapeBuffers = null
  let voronoiFrameSample = null
  let voronoiCoords = null
  let baseSourceSprite = null
  let currentMorph = null
  let currentProgress = 0
  let isDisposed = false
  let loadSeq = 0
  let rootTexture = null
  let renderWorker = null
  let workerReady = false
  let workerInFlight = false
  let workerInitRequestId = 0
  let workerFrameRequestId = 0
  let activeWorkerFrameRequestId = 0
  let workerPendingProgress = null
  let workerLastProgress = 0

  const resizeLayout = () => {
    if (!currentMorph) return
    fitContent(content, currentMorph.width, currentMorph.height, app.screen.width, app.screen.height)
  }

  const renderFrame = () => {
    if (isDisposed) return
    resizeLayout()
    app.render()
  }

  const clearScene = () => {
    if (baseSourceSprite) {
      baseSourceSprite.destroy({ texture: false, textureSource: false })
      baseSourceSprite = null
    }

    content.removeChildren()
    polygonLayer.clear()
    content.addChild(polygonLayer)
    renderData = null
    shapeBuffers = null
    voronoiFrameSample = null
    voronoiCoords = null

    if (rootTexture) {
      rootTexture.destroy(true)
      rootTexture = null
    }
  }

  const teardownRenderWorker = () => {
    if (!renderWorker) return

    try {
      renderWorker.postMessage({ type: 'dispose' })
    } catch {
      // Ignore channel errors during disposal.
    }

    renderWorker.terminate()
    renderWorker = null
    workerReady = false
    workerInFlight = false
    workerPendingProgress = null
    workerLastProgress = 0
    activeWorkerFrameRequestId = 0
  }

  const drawGrid = (p) => {
    if (!currentMorph?.grid || !renderData?.count) {
      polygonLayer.clear()
      return
    }

    const lockToTarget = p >= 0.999
    const sizeProgress = lockToTarget ? 1 : smoothstep(clamp((p - 0.68) / 0.32, 0, 1))
    const grid = currentMorph.grid

    polygonLayer.clear()

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

      const drawWidth = sourceWidth + (targetWidth - sourceWidth) * sizeProgress
      const drawHeight = sourceHeight + (targetHeight - sourceHeight) * sizeProgress

      polygonLayer.rect(
        sampleOut.x - drawWidth * 0.5,
        sampleOut.y - drawHeight * 0.5,
        drawWidth,
        drawHeight,
      ).fill({
        color: renderData.colors[localIndex],
        alpha: renderData.alphas[localIndex],
      })
    }
  }

  const drawPolygon = (p) => {
    if (!currentMorph?.grid || !renderData?.count || !shapeBuffers?.count) {
      polygonLayer.clear()
      return
    }

    const grid = currentMorph.grid
    const lockToTarget = p >= 0.999
    const morphT = lockToTarget ? 1 : p

    polygonLayer.clear()

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

      polygonLayer.moveTo(polygonPoints[0], polygonPoints[1])
      polygonLayer.lineTo(polygonPoints[2], polygonPoints[3])
      polygonLayer.lineTo(polygonPoints[4], polygonPoints[5])
      polygonLayer.lineTo(polygonPoints[6], polygonPoints[7])
      polygonLayer.closePath().fill({
        color: renderData.colors[localIndex],
        alpha: renderData.alphas[localIndex],
      })
    }
  }

  const drawVoronoiMesh = (offsets, points) => {
    if (!renderData?.count) {
      polygonLayer.clear()
      return
    }

    polygonLayer.clear()

    for (let localIndex = 0; localIndex < renderData.count; localIndex += 1) {
      const start = offsets[localIndex]
      const end = offsets[localIndex + 1]
      if (end - start < 6) continue

      polygonLayer.moveTo(points[start], points[start + 1])

      for (let cursor = start + 2; cursor < end; cursor += 2) {
        polygonLayer.lineTo(points[cursor], points[cursor + 1])
      }

      polygonLayer.closePath().fill({
        color: renderData.colors[localIndex],
        alpha: renderData.alphas[localIndex],
      })
    }
  }

  const drawVoronoiLocal = (p) => {
    if (!currentMorph?.grid || !renderData?.count || !voronoiCoords) {
      polygonLayer.clear()
      return
    }

    const lockToTarget = p >= 0.999

    for (let localIndex = 0; localIndex < renderData.count; localIndex += 1) {
      const sourceIndex = renderData.indices[localIndex]
      const base2 = sourceIndex * 2

      if (lockToTarget) {
        sampleOut.x = currentMorph.grid.targetPositions[base2]
        sampleOut.y = currentMorph.grid.targetPositions[base2 + 1]
      } else {
        sampleCellPosition(currentMorph.grid, sourceIndex, p, sampleOut)
      }

      const coordsBase = localIndex * 2
      voronoiCoords[coordsBase] = sampleOut.x
      voronoiCoords[coordsBase + 1] = sampleOut.y
    }

    const delaunay = new Delaunay(voronoiCoords)
    const voronoi = delaunay.voronoi([0, 0, currentMorph.width, currentMorph.height])

    polygonLayer.clear()

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

      polygonLayer.moveTo(startX, startY)

      for (let pointIndex = 1; pointIndex < polygon.length; pointIndex += 1) {
        const [px, py] = polygon[pointIndex]
        polygonLayer.lineTo(px, py)
      }

      polygonLayer.closePath().fill({
        color: renderData.colors[localIndex],
        alpha: renderData.alphas[localIndex],
      })
    }
  }

  const requestWorkerFrame = (progress) => {
    if (!renderWorker || !workerReady) return false

    const nextProgress = clamp(progress, 0, 1)
    workerPendingProgress = nextProgress

    if (workerInFlight) {
      return true
    }

    const requestProgress = workerPendingProgress
    workerPendingProgress = null
    workerInFlight = true
    workerLastProgress = requestProgress
    workerFrameRequestId += 1
    activeWorkerFrameRequestId = workerFrameRequestId

    renderWorker.postMessage({
      type: 'frame',
      requestId: workerFrameRequestId,
      progress: requestProgress,
    })

    return true
  }

  const ensureRenderWorker = () => {
    if (!useRenderWorker || renderWorker) return

    renderWorker = new Worker(new URL('../workers/render.worker.js', import.meta.url), {
      type: 'module',
    })

    renderWorker.onmessage = (event) => {
      if (isDisposed) return

      const payload = event.data || {}

      if (payload.type === 'ready') {
        if (payload.requestId !== workerInitRequestId) return

        workerReady = true
        workerInFlight = false
        requestWorkerFrame(currentProgress)
        return
      }

      if (payload.type === 'frame') {
        if (payload.requestId !== activeWorkerFrameRequestId) return
        if (!workerReady || !renderData?.count) return

        workerInFlight = false
        drawVoronoiMesh(payload.offsets, payload.points)
        currentProgress = clamp(Number(payload.progress) || workerLastProgress, 0, 1)
        renderFrame()

        if (workerPendingProgress != null) {
          requestWorkerFrame(workerPendingProgress)
        }
        return
      }

      if (payload.type === 'error') {
        workerInFlight = false
        workerReady = false
      }
    }

    renderWorker.onerror = () => {
      workerReady = false
      workerInFlight = false
    }
  }

  const initVoronoiWorker = () => {
    if (!useRenderWorker || rendererMode !== RENDERER_MODE_VORONOI || !voronoiFrameSample?.count) {
      teardownRenderWorker()
      return
    }

    ensureRenderWorker()
    if (!renderWorker) return

    workerReady = false
    workerInFlight = false
    workerPendingProgress = null
    activeWorkerFrameRequestId = 0
    workerInitRequestId += 1

    renderWorker.postMessage({
      type: 'init',
      requestId: workerInitRequestId,
      width: currentMorph?.width || 2,
      height: currentMorph?.height || 2,
      count: voronoiFrameSample.count,
      frameCount: voronoiFrameSample.frameCount,
      sourcePositions: voronoiFrameSample.sourcePositions,
      targetPositions: voronoiFrameSample.targetPositions,
      motionPath: voronoiFrameSample.motionPath,
    })
  }

  const applyProgress = (progress) => {
    if (!currentMorph?.grid || !renderData?.count) {
      polygonLayer.clear()
      renderFrame()
      return
    }

    const p = clamp(progress, 0, 1)
    const lockToTarget = p >= 0.999

    if (baseSourceSprite) {
      // Keep a short source-frame underlay to suppress first-frame grid interference.
      baseSourceSprite.alpha = Math.max(0, 1 - p * 14)
      baseSourceSprite.visible = baseSourceSprite.alpha > 0.001
    }

    if (rendererMode === RENDERER_MODE_GRID) {
      drawGrid(p)
      currentProgress = p
      renderFrame()
      return
    }

    if (rendererMode === RENDERER_MODE_POLYGON) {
      drawPolygon(p)
      currentProgress = p
      renderFrame()
      return
    }

    if (!lockToTarget && requestWorkerFrame(p)) {
      currentProgress = p
      renderFrame()
      return
    }

    drawVoronoiLocal(p)
    currentProgress = p
    renderFrame()
  }

  const rebuildRenderState = () => {
    if (!currentMorph?.grid) {
      renderData = null
      shapeBuffers = null
      voronoiFrameSample = null
      voronoiCoords = null
      teardownRenderWorker()
      return
    }

    renderData = getVoronoiRenderData(currentMorph.grid, renderCellBudget)
    shapeBuffers = rendererMode === RENDERER_MODE_POLYGON
      ? getMorphShapeBuffers(currentMorph.grid)
      : null
    voronoiFrameSample = rendererMode === RENDERER_MODE_VORONOI
      ? getVoronoiFrameSample(currentMorph.grid, renderCellBudget)
      : null
    voronoiCoords = rendererMode === RENDERER_MODE_VORONOI
      ? new Float64Array(renderData.count * 2)
      : null

    if (rendererMode === RENDERER_MODE_VORONOI) {
      initVoronoiWorker()
    } else {
      teardownRenderWorker()
    }
  }

  const setMorphData = async (morphData) => {
    const seq = ++loadSeq
    currentMorph = morphData || null
    clearScene()

    if (!currentMorph?.grid) {
      teardownRenderWorker()
      if (manualRender) renderFrame()
      return
    }

    rebuildRenderState()

    if (currentMorph.sourceRasterUrl) {
      try {
        const image = await loadImageElement(currentMorph.sourceRasterUrl)

        if (isDisposed || seq !== loadSeq) {
          return
        }

        rootTexture = Texture.from(image, true)

        baseSourceSprite = new Sprite(rootTexture)
        baseSourceSprite.position.set(0, 0)
        baseSourceSprite.anchor.set(0)
        baseSourceSprite.alpha = 1
        content.addChild(baseSourceSprite)
      } catch {
        // Source underlay is optional; rendering can continue with polygon cells only.
      }
    }

    content.addChild(polygonLayer)

    resizeLayout()
    applyProgress(currentProgress)
    renderFrame()
  }

  const setRendererMode = async (nextMode) => {
    const normalized = normalizeRendererMode(nextMode)
    if (normalized === rendererMode) return

    rendererMode = normalized
    renderCellBudget = resolveCellBudget(rendererMode, manualRender, options.renderCellBudget ?? options.voronoiCellBudget)

    if (currentMorph) {
      await setMorphData(currentMorph)
    }
  }

  const ticker = () => {
    resizeLayout()
  }

  if (!manualRender) {
    app.ticker.add(ticker)
  }

  const destroy = () => {
    if (isDisposed) return

    isDisposed = true

    if (!manualRender) {
      app.ticker.remove(ticker)
    }

    clearScene()
    teardownRenderWorker()
    app.destroy(true, { children: true, texture: false, textureSource: false })
  }

  return {
    canvas: app.canvas,
    setMorphData,
    setRendererMode,
    setProgress: applyProgress,
    renderFrame,
    destroy,
  }
}
