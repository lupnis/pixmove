const MIN_ALPHA = 0.18
const MIN_VORONOI_BUDGET = 128
const DEFAULT_VORONOI_BUDGET = 2600

const EMPTY_RENDER_DATA = {
	count: 0,
	indices: new Uint32Array(0),
	colors: new Uint32Array(0),
	alphas: new Float32Array(0),
	fillStyles: [],
}

const EMPTY_FRAME_SAMPLE = {
	count: 0,
	frameCount: 1,
	sourcePositions: new Float32Array(0),
	targetPositions: new Float32Array(0),
	motionPath: new Float32Array(0),
}

const renderDataCache = new WeakMap()
const frameSampleCache = new WeakMap()

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

const clampIndex = (value, maxExclusive) => {
	const parsed = Number.isFinite(Number(value)) ? Number(value) : 0
	return clamp(Math.round(parsed), 0, Math.max(0, maxExclusive - 1))
}

const normalizeBudget = (rawBudget, count) => {
	const parsed = Number.isFinite(Number(rawBudget))
		? Math.round(Number(rawBudget))
		: DEFAULT_VORONOI_BUDGET

	return clamp(parsed, MIN_VORONOI_BUDGET, Math.max(MIN_VORONOI_BUDGET, count))
}

const resolveGridDimensions = (grid, count) => {
	const columns = Math.max(
		1,
		Math.round(Number(grid?.columns) || Number(grid?.side) || Math.sqrt(Math.max(1, count))),
	)
	const rows = Math.max(
		1,
		Math.round(Number(grid?.rows) || Number(grid?.side) || Math.ceil(Math.max(1, count) / columns)),
	)

	return { columns, rows }
}

const buildSampleIndices = (columns, rows, count, budget) => {
	if (!count || !columns || !rows) return new Uint32Array(0)

	if (count <= budget) {
		const all = new Uint32Array(count)
		for (let i = 0; i < count; i += 1) {
			all[i] = i
		}
		return all
	}

	const aspect = columns / Math.max(1, rows)
	const targetColumns = Math.max(1, Math.round(Math.sqrt(budget * aspect)))
	const targetRows = Math.max(1, Math.round(budget / targetColumns))
	const strideX = Math.max(1, Math.ceil(columns / targetColumns))
	const strideY = Math.max(1, Math.ceil(rows / targetRows))
	const sampled = []
	const seen = new Set()

	const pushIndex = (index) => {
		if (index < 0 || index >= count) return
		if (seen.has(index)) return
		seen.add(index)
		sampled.push(index)
	}

	for (let y = 0; y < rows; y += strideY) {
		for (let x = 0; x < columns; x += strideX) {
			pushIndex(y * columns + x)
		}
	}

	// Keep boundary cells so silhouettes stay stable after down-sampling.
	const lastX = columns - 1
	const lastY = rows - 1
	for (let x = 0; x < columns; x += strideX) {
		pushIndex(lastY * columns + x)
	}
	for (let y = 0; y < rows; y += strideY) {
		pushIndex(y * columns + lastX)
	}
	pushIndex(lastY * columns + lastX)

	if (sampled.length <= budget) {
		return Uint32Array.from(sampled)
	}

	const compact = new Uint32Array(budget)
	const step = sampled.length / budget
	let cursor = 0

	for (let i = 0; i < budget; i += 1) {
		compact[i] = sampled[Math.floor(cursor)]
		cursor += step
	}

	return compact
}

const getBudgetCache = (store, grid) => {
	let cacheByBudget = store.get(grid)

	if (!cacheByBudget) {
		cacheByBudget = new Map()
		store.set(grid, cacheByBudget)
	}

	return cacheByBudget
}

export const getVoronoiRenderData = (grid, maxCells) => {
	const totalCount = Number(grid?.count) || 0
	if (!totalCount) return EMPTY_RENDER_DATA

	const { columns, rows } = resolveGridDimensions(grid, totalCount)
	const budget = normalizeBudget(maxCells, totalCount)
	const cacheByBudget = getBudgetCache(renderDataCache, grid)

	if (cacheByBudget.has(budget)) {
		return cacheByBudget.get(budget)
	}

	const indices = buildSampleIndices(columns, rows, totalCount, budget)
	const count = indices.length
	const colors = new Uint32Array(count)
	const alphas = new Float32Array(count)
	const fillStyles = new Array(count)

	for (let localIndex = 0; localIndex < count; localIndex += 1) {
		const sourceIndex = clampIndex(indices[localIndex], totalCount)
		const colorBase = sourceIndex * 4
		const red = grid.sourceColors?.[colorBase] ?? 255
		const green = grid.sourceColors?.[colorBase + 1] ?? 255
		const blue = grid.sourceColors?.[colorBase + 2] ?? 255
		const alpha = clamp((grid.sourceColors?.[colorBase + 3] ?? 255) / 255, MIN_ALPHA, 1)

		colors[localIndex] = (red << 16) | (green << 8) | blue
		alphas[localIndex] = alpha
		fillStyles[localIndex] = `rgba(${red}, ${green}, ${blue}, ${alpha})`
	}

	const data = {
		count,
		indices,
		colors,
		alphas,
		fillStyles,
	}

	cacheByBudget.set(budget, data)
	return data
}

export const getVoronoiFrameSample = (grid, maxCells) => {
	const totalCount = Number(grid?.count) || 0
	if (!totalCount) return EMPTY_FRAME_SAMPLE

	const renderData = getVoronoiRenderData(grid, maxCells)
	if (!renderData.count) return EMPTY_FRAME_SAMPLE

	const { columns, rows } = resolveGridDimensions(grid, totalCount)
	const budget = normalizeBudget(maxCells, totalCount)
	const cacheByBudget = getBudgetCache(frameSampleCache, grid)

	if (cacheByBudget.has(budget)) {
		return cacheByBudget.get(budget)
	}

	const frameCount = Math.max(1, Math.round(Number(grid.frameCount) || 1))
	const sourcePositions = new Float32Array(renderData.count * 2)
	const targetPositions = new Float32Array(renderData.count * 2)
	const motionPath = new Float32Array(frameCount * renderData.count * 2)

	for (let localIndex = 0; localIndex < renderData.count; localIndex += 1) {
		const sourceIndex = clampIndex(renderData.indices[localIndex], totalCount)
		const sourceBase2 = sourceIndex * 2
		const localBase2 = localIndex * 2

		sourcePositions[localBase2] = grid.sourcePositions?.[sourceBase2] ?? 0
		sourcePositions[localBase2 + 1] = grid.sourcePositions?.[sourceBase2 + 1] ?? 0
		targetPositions[localBase2] = grid.targetPositions?.[sourceBase2] ?? 0
		targetPositions[localBase2 + 1] = grid.targetPositions?.[sourceBase2 + 1] ?? 0

		for (let frame = 0; frame < frameCount; frame += 1) {
			const srcMotionBase = (frame * totalCount + sourceIndex) * 2
			const dstMotionBase = (frame * renderData.count + localIndex) * 2
			motionPath[dstMotionBase] = grid.motionPath?.[srcMotionBase] ?? sourcePositions[localBase2]
			motionPath[dstMotionBase + 1] = grid.motionPath?.[srcMotionBase + 1] ?? sourcePositions[localBase2 + 1]
		}
	}

	const frameSample = {
		count: renderData.count,
		frameCount,
		sourcePositions,
		targetPositions,
		motionPath,
		columns,
		rows,
	}

	cacheByBudget.set(budget, frameSample)
	return frameSample
}
