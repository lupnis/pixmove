import { Application, Container, Rectangle, Sprite, Texture } from 'pixi.js'
import { clamp, sampleCellPosition } from '../utils/morphPlayback'

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

export const createPixiMorphRenderer = async (host, options = {}) => {
  const app = new Application()
  const manualRender = Boolean(options.manualRender)

  await app.init(resolveInitOptions(host, options))

  if (host) {
    host.innerHTML = ''
    host.appendChild(app.canvas)
  }

  const root = new Container()
  const content = new Container()
  root.addChild(content)
  app.stage.addChild(root)

  let cellSprites = []
  let cellTextures = []
  let cellSizeMorph = []
  let baseSourceSprite = null
  let currentMorph = null
  let currentProgress = 0
  let isDisposed = false
  let loadSeq = 0
  let rootTexture = null

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

    for (const sprite of cellSprites) {
      sprite.destroy({ texture: false, textureSource: false })
    }

    for (const texture of cellTextures) {
      texture.destroy(false)
    }

    content.removeChildren()
    cellSprites = []
    cellTextures = []
    cellSizeMorph = []

    if (rootTexture) {
      rootTexture.destroy(true)
      rootTexture = null
    }
  }

  const applyProgress = (progress) => {
    if (!currentMorph?.grid || cellSprites.length === 0) return

    const p = clamp(progress, 0, 1)
    const position = { x: 0, y: 0 }
    const lockToTarget = p >= 0.999
    const targetPositions = currentMorph.grid.targetPositions
    const sizeProgress = lockToTarget ? 1 : clamp((p - 0.68) / 0.32, 0, 1)

    if (baseSourceSprite) {
      // Keep a short source-frame underlay to suppress first-frame grid interference.
      baseSourceSprite.alpha = Math.max(0, 1 - p * 14)
      baseSourceSprite.visible = baseSourceSprite.alpha > 0.001
    }

    for (let index = 0; index < cellSprites.length; index += 1) {
      const sprite = cellSprites[index]
      if (lockToTarget) {
        const base = index * 2
        sprite.position.set(targetPositions[base], targetPositions[base + 1])
      } else {
        sampleCellPosition(currentMorph.grid, index, p, position)
        sprite.position.set(position.x, position.y)
      }

      const sizeMeta = cellSizeMorph[index]
      if (sizeMeta) {
        const width = lockToTarget
          ? sizeMeta.targetWidth
          : sizeMeta.sourceWidth + (sizeMeta.targetWidth - sizeMeta.sourceWidth) * sizeProgress
        const height = lockToTarget
          ? sizeMeta.targetHeight
          : sizeMeta.sourceHeight + (sizeMeta.targetHeight - sizeMeta.sourceHeight) * sizeProgress

        sprite.width = width
        sprite.height = height
      }

      sprite.roundPixels = false
      sprite.alpha = 1
    }

    currentProgress = p
    renderFrame()
  }

  const setMorphData = async (morphData) => {
    const seq = ++loadSeq
    currentMorph = morphData || null
    clearScene()

    if (!currentMorph?.grid) {
      if (manualRender) renderFrame()
      return
    }

    const image = await loadImageElement(currentMorph.sourceRasterUrl)
    const sourceTexture = Texture.from(image, true)

    if (isDisposed || seq !== loadSeq) {
      sourceTexture.destroy(true)
      return
    }

    rootTexture = sourceTexture

    baseSourceSprite = new Sprite(rootTexture)
    baseSourceSprite.position.set(0, 0)
    baseSourceSprite.anchor.set(0)
    baseSourceSprite.alpha = 1
    content.addChild(baseSourceSprite)

    const { cellBounds, sourcePositions, sourceToTarget, count } = currentMorph.grid
    cellSizeMorph = []

    for (let index = 0; index < count; index += 1) {
      const base4 = index * 4
      const base2 = index * 2
      const frame = new Rectangle(
        cellBounds[base4],
        cellBounds[base4 + 1],
        cellBounds[base4 + 2],
        cellBounds[base4 + 3],
      )
      const texture = new Texture({
        source: rootTexture.source,
        frame,
      })
      const sprite = new Sprite(texture)
      sprite.anchor.set(0.5)
      sprite.position.set(sourcePositions[base2], sourcePositions[base2 + 1])
      const sourceWidth = cellBounds[base4 + 2]
      const sourceHeight = cellBounds[base4 + 3]
      const mappedTargetIndex = sourceToTarget?.[index]
      const safeTargetIndex = clamp(Number(mappedTargetIndex ?? index), 0, count - 1)
      const targetBase4 = safeTargetIndex * 4
      const targetWidth = cellBounds[targetBase4 + 2]
      const targetHeight = cellBounds[targetBase4 + 3]

      sprite.width = sourceWidth
      sprite.height = sourceHeight
      sprite.roundPixels = false
      content.addChild(sprite)
      cellSprites.push(sprite)
      cellTextures.push(texture)
      cellSizeMorph.push({
        sourceWidth,
        sourceHeight,
        targetWidth,
        targetHeight,
      })
    }

    resizeLayout()
    applyProgress(currentProgress)
    renderFrame()
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
    app.destroy(true, { children: true, texture: false, textureSource: false })
  }

  return {
    canvas: app.canvas,
    setMorphData,
    setProgress: applyProgress,
    renderFrame,
    destroy,
  }
}
