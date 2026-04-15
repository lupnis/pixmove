const MIN_ALPHA = 0.18
const MIN_VORONOI_BUDGET = 128
const DEFAULT_VORONOI_BUDGET = 2600
const TARGET_FEATURE_BIAS = 0.28
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

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

const buildSourceStrideIndices = (columns, rows, count, budget) => {
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

const compactIndices = (indices, budget) => {
	if (indices.length <= budget) {
		return Uint32Array.from(indices)
	}

	const compact = new Uint32Array(budget)
	const step = indices.length / budget
	let cursor = 0

	for (let i = 0; i < budget; i += 1) {
		compact[i] = indices[Math.floor(cursor)]
		cursor += step
	}

	return compact
}

const selectBestTargetIndexInWindow = (x0, y0, x1, y1, columns, rows, weights) => {
	let bestIndex = y0 * columns + x0
	let bestScore = Number.NEGATIVE_INFINITY
	const centerX = (x0 + x1 - 1) * 0.5
	const centerY = (y0 + y1 - 1) * 0.5

	for (let y = y0; y < y1; y += 1) {
		for (let x = x0; x < x1; x += 1) {
			const index = y * columns + x
			const dx = x - centerX
			const dy = y - centerY
			const centerPenalty = (dx * dx + dy * dy) * 0.028
			const boundaryBonus = x === 0 || y === 0 || x === columns - 1 || y === rows - 1 ? 0.04 : 0
			const featureWeight = weights?.[index] ?? 1
			const score = featureWeight * (1 + TARGET_FEATURE_BIAS) - centerPenalty + boundaryBonus

			if (score > bestScore) {
				bestScore = score
				bestIndex = index
			}
		}
	}

	return bestIndex
}

const buildTargetAnchoredSampleIndices = (grid, columns, rows, count, budget) => {
	const targetToSource = grid?.targetToSource
	if (!ArrayBuffer.isView(targetToSource)) {
		return null
	}
	if (targetToSource.length < count) return null

	const weights = grid?.targetWeights?.length >= count ? grid.targetWeights : null
	const aspect = columns / Math.max(1, rows)
	const windowColumns = clamp(Math.round(Math.sqrt(budget * aspect)), 1, columns)
	const windowRows = clamp(Math.round(budget / windowColumns), 1, rows)
	const sampled = []
	const seen = new Set()

	const pushTargetIndex = (targetIndex) => {
		const clampedTarget = clampIndex(targetIndex, count)
		const sourceIndex = clampIndex(targetToSource[clampedTarget], count)
		if (seen.has(sourceIndex)) return
		seen.add(sourceIndex)
		sampled.push(sourceIndex)
	}

	for (let windowY = 0; windowY < windowRows; windowY += 1) {
		const y0 = Math.floor((windowY * rows) / windowRows)
		const y1 = Math.max(y0 + 1, Math.floor(((windowY + 1) * rows) / windowRows))

		for (let windowX = 0; windowX < windowColumns; windowX += 1) {
			const x0 = Math.floor((windowX * columns) / windowColumns)
			const x1 = Math.max(x0 + 1, Math.floor(((windowX + 1) * columns) / windowColumns))
			const targetIndex = selectBestTargetIndexInWindow(x0, y0, x1, y1, columns, rows, weights)
			pushTargetIndex(targetIndex)
		}
	}

	if (sampled.length < budget) {
		const totalTargets = columns * rows
		const fallbackStep = Math.max(1, Math.floor(totalTargets / Math.max(1, budget - sampled.length)))
		for (let targetIndex = 0; targetIndex < totalTargets && sampled.length < budget; targetIndex += fallbackStep) {
			pushTargetIndex(targetIndex)
		}
	}

	return compactIndices(sampled, budget)
}

const buildSampleIndices = (grid, columns, rows, count, budget) => {
	if (!count || !columns || !rows) return new Uint32Array(0)

	if (count <= budget) {
		const all = new Uint32Array(count)
		for (let i = 0; i < count; i += 1) {
			all[i] = i
		}
		return all
	}

	const targetAnchored = buildTargetAnchoredSampleIndices(grid, columns, rows, count, budget)
	if (targetAnchored?.length) {
		return targetAnchored
	}

	return buildSourceStrideIndices(columns, rows, count, budget)
}

export const stabilizeVoronoiCoords = (coords, width, height) => {
	if (!coords?.length) return coords

	const safeWidth = Math.max(1, Number(width) || 1)
	const safeHeight = Math.max(1, Number(height) || 1)
	const count = Math.floor(coords.length / 2)
	const bucketSize = Math.max(
		0.75,
		Math.min(safeWidth, safeHeight) / Math.max(48, Math.sqrt(Math.max(1, count))),
	)
	const buckets = new Map()

	for (let index = 0; index < count; index += 1) {
		const base = index * 2
		let x = clamp(Number(coords[base]) || 0, 0, safeWidth)
		let y = clamp(Number(coords[base + 1]) || 0, 0, safeHeight)
		const bucketX = Math.round(x / bucketSize)
		const bucketY = Math.round(y / bucketSize)
		const key = `${bucketX}:${bucketY}`
		const seen = buckets.get(key) || 0

		if (seen > 0) {
			const angle = (index + 1) * GOLDEN_ANGLE
			const radius = Math.min(bucketSize * 0.34, 0.36 + seen * 0.18)
			x = clamp(x + Math.cos(angle) * radius, 0, safeWidth)
			y = clamp(y + Math.sin(angle) * radius, 0, safeHeight)
		}

		buckets.set(key, seen + 1)
		coords[base] = x
		coords[base + 1] = y
	}

	return coords
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

	const indices = buildSampleIndices(grid, columns, rows, totalCount, budget)
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
		targetPositions[localBase2] = grid.finalSitePositions?.[sourceBase2] ?? grid.targetPositions?.[sourceBase2] ?? 0
		targetPositions[localBase2 + 1] = grid.finalSitePositions?.[sourceBase2 + 1] ?? grid.targetPositions?.[sourceBase2 + 1] ?? 0

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
