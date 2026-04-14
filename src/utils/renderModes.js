export const RENDERER_MODE_GRID = 'grid'
export const RENDERER_MODE_POLYGON = 'polygon'
export const RENDERER_MODE_VORONOI = 'voronoi'

export const RENDERER_MODE_OPTIONS = [
  RENDERER_MODE_GRID,
  RENDERER_MODE_POLYGON,
  RENDERER_MODE_VORONOI,
]

export const DEFAULT_RENDERER_MODE = RENDERER_MODE_VORONOI

export const normalizeRendererMode = (mode) =>
  RENDERER_MODE_OPTIONS.includes(mode) ? mode : DEFAULT_RENDERER_MODE