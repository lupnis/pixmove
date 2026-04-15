import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js'
import { Delaunay } from 'd3-delaunay'
import { clamp, sampleCellPosition, smoothstep } from '../utils/morphPlayback'
import { getMorphShapeBuffers, interpolateCellPolygon } from '../utils/morphPolygons'
import {
  getTransportRenderState,
  sampleTransportParticle,
} from '../utils/morphTransport'
import { getVoronoiFrameSample, getVoronoiRenderData, stabilizeVoronoiCoords } from '../utils/morphVoronoi'
import { getGridFlowRenderState } from '../utils/gridFlow'
import { createJamRenderState, sampleJamCenters } from '../utils/morphJam'
import {
  DEFAULT_RENDERER_MODE,
  normalizeRendererMode,
  RENDERER_MODE_GRID,
  RENDERER_MODE_GRID_FLOW,
  RENDERER_MODE_JAM,
  RENDERER_MODE_POLYGON,
  RENDERER_MODE_TRANSPORT,
  RENDERER_MODE_VORONOI,
} from '../utils/renderModes'

const MIN_RENDER_CELL_BUDGET = 128
const DEFAULT_PREVIEW_GRID_CELLS = 4200
const DEFAULT_PREVIEW_POLYGON_CELLS = 3200
const DEFAULT_PREVIEW_JAM_CELLS = 4200
const DEFAULT_PREVIEW_TRANSPORT_CELLS = 5600
const DEFAULT_PREVIEW_VORONOI_CELLS = 7200
const DEFAULT_EXPORT_GRID_CELLS = 5200
const DEFAULT_EXPORT_POLYGON_CELLS = 4200
const DEFAULT_EXPORT_JAM_CELLS = 7600
const DEFAULT_EXPORT_TRANSPORT_CELLS = 9200
const DEFAULT_EXPORT_VORONOI_CELLS = 14000

const resolveRevealProgress = (progress) =>
  smoothstep(clamp(Number(progress) / 0.18, 0, 1))

const resolveGridFlowMotionProgress = (progress, sourceOverlayActive) => {
  const p = clamp(Number(progress) || 0, 0, 1)
  if (!sourceOverlayActive) return p
  return p
}

const resolveRevealHash = (sourceIndex) => {
  const seed = (Math.imul((sourceIndex + 1) ^ 0x9e3779b9, 2654435761) >>> 0)
  return seed / 4294967295
}

const isSourceRevealed = (sourceIndex, revealProgress) =>
  revealProgress >= 0.999 || resolveRevealHash(sourceIndex) <= revealProgress

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
  if (rendererMode === RENDERER_MODE_GRID || rendererMode === RENDERER_MODE_GRID_FLOW) {
    return manualRender ? DEFAULT_EXPORT_GRID_CELLS : DEFAULT_PREVIEW_GRID_CELLS
  }

  if (rendererMode === RENDERER_MODE_POLYGON) {
    return manualRender ? DEFAULT_EXPORT_POLYGON_CELLS : DEFAULT_PREVIEW_POLYGON_CELLS
  }

  if (rendererMode === RENDERER_MODE_JAM) {
    return manualRender ? DEFAULT_EXPORT_JAM_CELLS : DEFAULT_PREVIEW_JAM_CELLS
  }

  if (rendererMode === RENDERER_MODE_TRANSPORT) {
    return manualRender ? DEFAULT_EXPORT_TRANSPORT_CELLS : DEFAULT_PREVIEW_TRANSPORT_CELLS
  }

  return manualRender ? DEFAULT_EXPORT_VORONOI_CELLS : DEFAULT_PREVIEW_VORONOI_CELLS
}

const resolveCellBudget = (rendererMode, manualRender, rawBudget) => {
  const defaultBudget = resolveDefaultCellBudget(rendererMode, manualRender)
  return Math.max(MIN_RENDER_CELL_BUDGET, Math.round(Number(rawBudget) || defaultBudget))
}

const resolveExplicitCellBudget = (rendererMode, manualRender, rawBudget) => {
  if (!Number.isFinite(Number(rawBudget))) {
    return undefined
  }

  return resolveCellBudget(rendererMode, manualRender, rawBudget)
}

const resolveModeBudget = (grid, rendererMode, renderCellBudget, manualRender) => {
  const totalCount = Number(grid?.count) || 0
  if (!totalCount) return 0

  if (
    rendererMode === RENDERER_MODE_GRID
    || rendererMode === RENDERER_MODE_GRID_FLOW
    || rendererMode === RENDERER_MODE_POLYGON
    || rendererMode === RENDERER_MODE_TRANSPORT
  ) {
    return totalCount
  }

  const hasExplicitBudget = Number.isFinite(Number(renderCellBudget))
  if (!hasExplicitBudget) {
    return totalCount
  }

  return Math.min(totalCount, Math.max(MIN_RENDER_CELL_BUDGET, Math.round(Number(renderCellBudget) || totalCount)))
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

export const createPixiMorphRenderer = async (host, options = {}) => {
  const app = new Application()
  const manualRender = Boolean(options.manualRender)
  let sourceOverlayEnabled = Boolean(options.sourceOverlayEnabled)
  const useRenderWorker = !manualRender
    && options.useRenderWorker !== false
    && typeof Worker !== 'undefined'
  let rendererMode = normalizeRendererMode(options.rendererMode ?? DEFAULT_RENDERER_MODE)
  let renderCellBudget = resolveExplicitCellBudget(
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

  const sampleOut = { x: 0, y: 0, width: 0, height: 0, angle: 0 }
  const polygonPoints = new Float32Array(32)

  let renderData = null
  let shapeBuffers = null
  let gridFlowState = null
  let jamState = null
  let jamCoords = null
  let transportState = null
  let transportCoords = null
  let flowSmoothX = null
  let flowSmoothY = null
  let flowSmoothInitialized = false
  let flowLastProgress = -1
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
    gridFlowState = null
    jamState = null
    jamCoords = null
    transportState = null
    transportCoords = null
    flowSmoothX = null
    flowSmoothY = null
    flowSmoothInitialized = false
    flowLastProgress = -1
    voronoiFrameSample = null
    voronoiCoords = null

    if (rootTexture) {
      rootTexture.destroy(true)
      rootTexture = null
    }
  }

  const resolveEffectiveRevealProgress = (progress) => {
    if (!sourceOverlayEnabled || !baseSourceSprite) {
      return 1
    }

    return resolveRevealProgress(progress)
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

    const revealProgress = resolveEffectiveRevealProgress(p)

    const tailBlend = smoothstep(clamp((p - 0.82) / 0.18, 0, 1))
    const motionT = p
    const sizeProgress = p
    const grid = currentMorph.grid
    const viewScale = Math.max(0.0001, Math.min(app.screen.width / currentMorph.width, app.screen.height / currentMorph.height))
    const overlapPxBase = 1.85 + (2.45 - 1.85) * tailBlend
    const overlapWorldBase = overlapPxBase / viewScale
    const samplePrevOut = { x: 0, y: 0 }
    const motionStep = clamp(2 / Math.max(2, Number(grid?.frameCount) || 96), 0.006, 0.03)
    const motionBoost = 1 - tailBlend * 0.88

    polygonLayer.clear()

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

      const motionOverlapWorld = Math.min(4 / viewScale, motionDistance * 0.55 * motionBoost)
      const overlapWorld = overlapWorldBase + motionOverlapWorld
      const strokeWidth = Math.max(
        1,
        overlapPxBase * 1.2 + Math.min(3.0, motionDistance * viewScale * 0.42 * motionBoost),
      )

      const boundBase = sourceIndex * 4
      const sourceWidth = grid.cellBounds?.[boundBase + 2] ?? 1
      const sourceHeight = grid.cellBounds?.[boundBase + 3] ?? 1
      const mappedTargetIndex = clamp(Number(grid.sourceToTarget?.[sourceIndex] ?? sourceIndex), 0, grid.count - 1)
      const targetBoundBase = mappedTargetIndex * 4
      const targetWidth = grid.cellBounds?.[targetBoundBase + 2] ?? sourceWidth
      const targetHeight = grid.cellBounds?.[targetBoundBase + 3] ?? sourceHeight

      const drawWidth = sourceWidth + (targetWidth - sourceWidth) * sizeProgress + overlapWorld * 2
      const drawHeight = sourceHeight + (targetHeight - sourceHeight) * sizeProgress + overlapWorld * 2

      polygonLayer.rect(
        sampleOut.x - drawWidth * 0.5,
        sampleOut.y - drawHeight * 0.5,
        drawWidth,
        drawHeight,
      ).fill({
        color: renderData.colors[localIndex],
        alpha: renderData.alphas[localIndex],
      }).stroke({
        width: strokeWidth,
        color: renderData.colors[localIndex],
        alpha: renderData.alphas[localIndex],
        join: 'round',
      })
    }
  }

  const drawGridFlow = (p) => {
    if (!currentMorph?.grid || !gridFlowState?.count || !gridFlowState.sourceCellByFrame?.length) {
      polygonLayer.clear()
      return
    }

    const sourceOverlayActive = sourceOverlayEnabled && Boolean(baseSourceSprite)
    const revealProgress = resolveEffectiveRevealProgress(p)
    const motionProgress = resolveGridFlowMotionProgress(p, sourceOverlayActive)

    const grid = currentMorph.grid
    const count = gridFlowState.count
    const frameCount = Math.max(2, gridFlowState.frameCount || 2)
    const frameProgress = clamp(motionProgress, 0, 1) * (frameCount - 1)
    const frameA = Math.floor(frameProgress)
    const frameB = Math.min(frameCount - 1, frameA + 1)
    const localT = frameProgress - frameA
    const offsetA = frameA * count
    const offsetB = frameB * count
    const tailBlend = smoothstep(clamp((motionProgress - 0.8) / 0.2, 0, 1))
    const viewScale = Math.max(0.0001, Math.min(app.screen.width / currentMorph.width, app.screen.height / currentMorph.height))
    const overlapPxBase = 2.8 + (3.5 - 2.8) * tailBlend
    const resetSmoothing = !flowSmoothInitialized || motionProgress < flowLastProgress - 0.0001
    const forceTarget = motionProgress >= 1
    const progressDelta = resetSmoothing ? 0 : Math.max(0, motionProgress - flowLastProgress)
    const virtualFrameSpan = progressDelta * Math.max(1, frameCount - 1)
    const stepBudgetPx = forceTarget
      ? Number.POSITIVE_INFINITY
      : Math.max(0.15, virtualFrameSpan)
    const maxStepWorld = stepBudgetPx / viewScale

    polygonLayer.clear()

    for (let sourceIndex = 0; sourceIndex < count; sourceIndex += 1) {
      const cellA = gridFlowState.sourceCellByFrame[offsetA + sourceIndex]
      const cellB = gridFlowState.sourceCellByFrame[offsetB + sourceIndex]

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
        flowSmoothX[sourceIndex] = targetCenterX
        flowSmoothY[sourceIndex] = targetCenterY
      } else {
        const deltaX = targetCenterX - flowSmoothX[sourceIndex]
        const deltaY = targetCenterY - flowSmoothY[sourceIndex]
        const deltaLength = Math.hypot(deltaX, deltaY)

        if (deltaLength > maxStepWorld) {
          const ratio = maxStepWorld / deltaLength
          flowSmoothX[sourceIndex] += deltaX * ratio
          flowSmoothY[sourceIndex] += deltaY * ratio
        } else {
          flowSmoothX[sourceIndex] = targetCenterX
          flowSmoothY[sourceIndex] = targetCenterY
        }
      }

      const centerX = flowSmoothX[sourceIndex]
      const centerY = flowSmoothY[sourceIndex]

      if (!isSourceRevealed(sourceIndex, revealProgress)) continue

      const overlapWorld = overlapPxBase / viewScale
      const strokeWidth = Math.max(1, overlapPxBase * 1.2)
      const drawWidth = Math.max(cellAW, cellBW) + overlapWorld * 2
      const drawHeight = Math.max(cellAH, cellBH) + overlapWorld * 2

      polygonLayer.rect(
        centerX - drawWidth * 0.5,
        centerY - drawHeight * 0.5,
        drawWidth,
        drawHeight,
      ).fill({
        color: gridFlowState.colors[sourceIndex],
        alpha: gridFlowState.alphas[sourceIndex],
      }).stroke({
        width: strokeWidth,
        color: gridFlowState.colors[sourceIndex],
        alpha: gridFlowState.alphas[sourceIndex],
        join: 'round',
      })
    }

    flowSmoothInitialized = true
    flowLastProgress = motionProgress
  }

  const drawPolygon = (p) => {
    if (!currentMorph?.grid || !renderData?.count || !shapeBuffers?.count) {
      polygonLayer.clear()
      return
    }

    const revealProgress = resolveEffectiveRevealProgress(p)

    const grid = currentMorph.grid
    const tailBlend = smoothstep(clamp((p - 0.82) / 0.18, 0, 1))
    const motionT = p
    const morphT = p
    const viewScale = Math.max(0.0001, Math.min(app.screen.width / currentMorph.width, app.screen.height / currentMorph.height))
    const radialScaleBase = 1.07 + (1.05 - 1.07) * tailBlend
    const overlapPxBase = 2.1 + (2.85 - 2.1) * tailBlend
    const overlapWorldBase = overlapPxBase / viewScale
    const samplePrevOut = { x: 0, y: 0 }
    const motionStep = clamp(2 / Math.max(2, Number(grid?.frameCount) || 96), 0.006, 0.03)
    const motionBoost = 1 - tailBlend * 0.88

    polygonLayer.clear()

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

      const motionOverlapWorld = Math.min(4 / viewScale, motionDistance * 0.55 * motionBoost)
      const overlapWorld = overlapWorldBase + motionOverlapWorld
      const radialScale = radialScaleBase + Math.min(0.2, motionDistance * 0.03 * motionBoost)
      const strokeWidth = Math.max(
        1,
        overlapPxBase * 1.25 + Math.min(3.2, motionDistance * viewScale * 0.45 * motionBoost),
      )

      interpolateCellPolygon(shapeBuffers, sourceIndex, sampleOut.x, sampleOut.y, morphT, polygonPoints)

      expandPolygonForOverlap(polygonPoints, sampleOut.x, sampleOut.y, radialScale, overlapWorld)

      if (!Number.isFinite(polygonPoints[0]) || !Number.isFinite(polygonPoints[1])) continue

      polygonLayer.moveTo(polygonPoints[0], polygonPoints[1])
      polygonLayer.lineTo(polygonPoints[2], polygonPoints[3])
      polygonLayer.lineTo(polygonPoints[4], polygonPoints[5])
      polygonLayer.lineTo(polygonPoints[6], polygonPoints[7])
      polygonLayer.closePath().fill({
        color: renderData.colors[localIndex],
        alpha: renderData.alphas[localIndex],
      }).stroke({
        width: strokeWidth,
        color: renderData.colors[localIndex],
        alpha: renderData.alphas[localIndex],
        join: 'round',
      })
    }
  }

  const drawJam = (p) => {
    if (!currentMorph?.grid || !renderData?.count || !jamState?.count || !jamCoords) {
      polygonLayer.clear()
      return
    }

    const revealProgress = resolveEffectiveRevealProgress(p)
    if (revealProgress <= 0.001) {
      polygonLayer.clear()
      return
    }

    sampleJamCenters(
      currentMorph.grid,
      jamState,
      p,
      jamCoords,
      sampleOut,
      currentMorph.width,
      currentMorph.height,
    )

    const delaunay = new Delaunay(jamCoords)
    const voronoi = delaunay.voronoi([0, 0, currentMorph.width, currentMorph.height])
    const edgeBlend = smoothstep(clamp((p - 0.22) / 0.46, 0, 1))
    const strokeWidth = 0.5 + edgeBlend * 0.34

    polygonLayer.clear()

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

      polygonLayer.moveTo(startX, startY)

      for (let pointIndex = 1; pointIndex < polygon.length; pointIndex += 1) {
        const [px, py] = polygon[pointIndex]
        polygonLayer.lineTo(px, py)
      }

      polygonLayer.closePath().fill({
        color: renderData.colors[localIndex],
        alpha: renderData.alphas[localIndex],
      }).stroke({
        width: strokeWidth,
        color: renderData.colors[localIndex],
        alpha: renderData.alphas[localIndex],
        join: 'round',
      })
    }
  }

  const drawTransport = (p) => {
    if (!renderData?.count || !transportState?.count || !transportCoords) {
      polygonLayer.clear()
      return
    }

    const revealProgress = resolveEffectiveRevealProgress(p)

    for (let localIndex = 0; localIndex < renderData.count; localIndex += 1) {
      sampleTransportParticle(transportState, p, localIndex, sampleOut)
      const coordsBase = localIndex * 2
      transportCoords[coordsBase] = clamp(sampleOut.x, 0, currentMorph.width)
      transportCoords[coordsBase + 1] = clamp(sampleOut.y, 0, currentMorph.height)
    }

    stabilizeVoronoiCoords(transportCoords, currentMorph.width, currentMorph.height)

    const delaunay = new Delaunay(transportCoords)
    const voronoi = delaunay.voronoi([0, 0, currentMorph.width, currentMorph.height])

    polygonLayer.clear()

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

  const drawVoronoiMesh = (offsets, points, progress) => {
    if (!renderData?.count) {
      polygonLayer.clear()
      return
    }

    const revealProgress = resolveEffectiveRevealProgress(progress)

    polygonLayer.clear()

    for (let localIndex = 0; localIndex < renderData.count; localIndex += 1) {
      const sourceIndex = renderData.indices[localIndex]
      if (!isSourceRevealed(sourceIndex, revealProgress)) continue

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

    const revealProgress = resolveEffectiveRevealProgress(p)

    for (let localIndex = 0; localIndex < renderData.count; localIndex += 1) {
      const sourceIndex = renderData.indices[localIndex]

      sampleCellPosition(currentMorph.grid, sourceIndex, p, sampleOut, {
        useFinalSitePositions: true,
        finalSiteBlendStart: 0.72,
        finalSiteBlendDuration: 0.24,
      })

      const coordsBase = localIndex * 2
      voronoiCoords[coordsBase] = clamp(sampleOut.x, 0, currentMorph.width)
      voronoiCoords[coordsBase + 1] = clamp(sampleOut.y, 0, currentMorph.height)
    }

    stabilizeVoronoiCoords(voronoiCoords, currentMorph.width, currentMorph.height)

    const delaunay = new Delaunay(voronoiCoords)
    const voronoi = delaunay.voronoi([0, 0, currentMorph.width, currentMorph.height])

    polygonLayer.clear()

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
        drawVoronoiMesh(payload.offsets, payload.points, payload.progress)
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
    if (baseSourceSprite) {
      if (sourceOverlayEnabled) {
        const revealProgress = resolveRevealProgress(p)
        const fadeAfterReveal = smoothstep(clamp((p - 0.24) / 0.08, 0, 1))
        baseSourceSprite.alpha = revealProgress < 0.995 ? 1 : Math.max(0, 1 - fadeAfterReveal)
      } else {
        baseSourceSprite.alpha = 0
      }
      baseSourceSprite.visible = baseSourceSprite.alpha > 0.001
    }

    if (rendererMode === RENDERER_MODE_GRID) {
      drawGrid(p)
      currentProgress = p
      renderFrame()
      return
    }

    if (rendererMode === RENDERER_MODE_GRID_FLOW) {
      drawGridFlow(p)
      currentProgress = p
      renderFrame()
      return
    }

    if (rendererMode === RENDERER_MODE_JAM) {
      drawJam(p)
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

    if (rendererMode === RENDERER_MODE_TRANSPORT) {
      drawTransport(p)
      currentProgress = p
      renderFrame()
      return
    }

    if (requestWorkerFrame(p)) {
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

    const defaultModeBudget = resolveModeBudget(currentMorph.grid, rendererMode, renderCellBudget, manualRender)
    const modeBudget = rendererMode === RENDERER_MODE_JAM
      ? Math.min(
        Number(currentMorph.grid.count) || 0,
        resolveCellBudget(rendererMode, manualRender, renderCellBudget),
      )
      : defaultModeBudget

    renderData = getVoronoiRenderData(currentMorph.grid, modeBudget)
    shapeBuffers = rendererMode === RENDERER_MODE_POLYGON
      ? getMorphShapeBuffers(currentMorph.grid)
      : null
    gridFlowState = rendererMode === RENDERER_MODE_GRID_FLOW
      ? getGridFlowRenderState(currentMorph.grid)
      : null
    jamState = rendererMode === RENDERER_MODE_JAM
      ? createJamRenderState(currentMorph.grid, renderData)
      : null
    jamCoords = rendererMode === RENDERER_MODE_JAM
      ? new Float64Array(renderData.count * 2)
      : null
    transportState = rendererMode === RENDERER_MODE_TRANSPORT
      ? getTransportRenderState(currentMorph.grid, renderData)
      : null
    transportCoords = rendererMode === RENDERER_MODE_TRANSPORT
      ? new Float64Array(renderData.count * 2)
      : null
    flowSmoothX = gridFlowState ? new Float32Array(gridFlowState.count) : null
    flowSmoothY = gridFlowState ? new Float32Array(gridFlowState.count) : null
    flowSmoothInitialized = false
    flowLastProgress = -1
    voronoiFrameSample = rendererMode === RENDERER_MODE_VORONOI
      ? getVoronoiFrameSample(currentMorph.grid, modeBudget)
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
    renderCellBudget = resolveExplicitCellBudget(
      rendererMode,
      manualRender,
      options.renderCellBudget ?? options.voronoiCellBudget,
    )

    if (currentMorph) {
      await setMorphData(currentMorph)
    }
  }

  const setSourceOverlayEnabled = (enabled) => {
    sourceOverlayEnabled = Boolean(enabled)
    if (currentMorph?.grid && renderData?.count) {
      applyProgress(currentProgress)
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
    setSourceOverlayEnabled,
    setProgress: applyProgress,
    renderFrame,
    destroy,
  }
}
