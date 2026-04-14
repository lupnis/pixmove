import wasmUrl from '../wasm/generated/morph.wasm?url'

let wasmPromise = null

const getWasm = async () => {
  if (wasmPromise) return wasmPromise

  wasmPromise = (async () => {
    const response = await fetch(wasmUrl)
    const bytes = await response.arrayBuffer()
    const { instance } = await WebAssembly.instantiate(bytes, {})
    const exports = instance.exports

    return {
      memory: exports.memory,
      alloc: exports.alloc,
      resetHeap: exports.resetHeap,
      initAssignments: exports.initAssignments,
      stepAssignments: exports.stepAssignments,
      finalizeAssignments: exports.finalizeAssignments,
      initMotionState: exports.initMotionState,
      simulateMotionFrames: exports.simulateMotionFrames,
      settleMotionBackward: exports.settleMotionBackward,
      settleMotionForward: exports.settleMotionForward,
    }
  })()

  return wasmPromise
}

const writeBytes = (memory, alloc, bytes) => {
  const ptr = alloc(bytes.byteLength)
  new Uint8Array(memory.buffer, ptr, bytes.byteLength).set(bytes)
  return ptr
}

const allocBytes = (memory, alloc, size) => ({
  ptr: alloc(size),
  size,
})

export const createAssignmentsWasmRunner = async (
  sourceColors,
  targetColors,
  targetWeights,
  columns,
  rows,
  proximityFactor,
) => {
  const wasm = await getWasm()
  const count = Math.max(1, columns) * Math.max(1, rows)
  const maxGenerations = 96
  const swapsPerGeneration = Math.max(count * 36, 8192)

  wasm.resetHeap()

  const sourceColorsPtr = writeBytes(wasm.memory, wasm.alloc, sourceColors)
  const targetColorsPtr = writeBytes(wasm.memory, wasm.alloc, targetColors)
  const targetWeightsPtr = writeBytes(
    wasm.memory,
    wasm.alloc,
    new Uint8Array(targetWeights.buffer, targetWeights.byteOffset, targetWeights.byteLength),
  )
  const targetToSourcePtr = allocBytes(wasm.memory, wasm.alloc, count * 4).ptr
  const sourceToTargetPtr = allocBytes(wasm.memory, wasm.alloc, count * 4).ptr
  const heuristicsPtr = allocBytes(wasm.memory, wasm.alloc, count * 8).ptr

  wasm.initAssignments(
    sourceColorsPtr,
    targetColorsPtr,
    targetWeightsPtr,
    targetToSourcePtr,
    heuristicsPtr,
    columns,
    rows,
    count,
    proximityFactor,
  )

  let generation = 0
  let acceptedSwaps = 0
  let maxDistance = Math.max(columns, rows)
  let done = false

  return {
    count,
    maxGenerations,
    step(chunkGenerations = 1) {
      const iterations = Math.max(1, Math.round(Number(chunkGenerations) || 1))
      let swapsMade = 0

      for (let step = 0; step < iterations && !done && generation < maxGenerations; step += 1) {
        const distance = Math.max(2, Math.round(maxDistance))
        swapsMade = wasm.stepAssignments(
          sourceColorsPtr,
          targetColorsPtr,
          targetWeightsPtr,
          targetToSourcePtr,
          heuristicsPtr,
          columns,
          rows,
          count,
          proximityFactor,
          distance,
          swapsPerGeneration,
        )

        acceptedSwaps += swapsMade
        generation += 1

        const minSwaps = Math.max(8, Math.floor(count * 0.002))
        if (maxDistance <= 2.2 && swapsMade < minSwaps) {
          done = true
          break
        }

        maxDistance = Math.max(2, maxDistance * 0.985)
      }

      const isDone = done || generation >= maxGenerations

      return {
        generation,
        acceptedSwaps,
        swapsMade,
        done: isDone,
        progress: isDone ? 1 : generation / maxGenerations,
      }
    },
    finalize() {
      wasm.finalizeAssignments(targetToSourcePtr, sourceToTargetPtr, count)

      return {
        targetToSource: new Uint32Array(wasm.memory.buffer, targetToSourcePtr, count).slice(),
        sourceToTarget: new Uint32Array(wasm.memory.buffer, sourceToTargetPtr, count).slice(),
        stats: Int32Array.from([generation, acceptedSwaps]),
      }
    },
  }
}

export const createMotionSimulationWasmRunner = async (
  sourcePositions,
  targetPositions,
  width,
  height,
  columns,
  rows,
  frameCount,
) => {
  const wasm = await getWasm()
  const count = sourcePositions.length / 2
  const motionBytes = count * frameCount * 2 * 4
  const positionsBytes = count * 2 * 4
  const agesBytes = count * 2
  const gridHeadBytes = Math.max(1, columns * rows) * 4

  wasm.resetHeap()

  const sourcePositionsPtr = writeBytes(
    wasm.memory,
    wasm.alloc,
    new Uint8Array(sourcePositions.buffer, sourcePositions.byteOffset, sourcePositions.byteLength),
  )
  const targetPositionsPtr = writeBytes(
    wasm.memory,
    wasm.alloc,
    new Uint8Array(targetPositions.buffer, targetPositions.byteOffset, targetPositions.byteLength),
  )
  const motionPathPtr = allocBytes(wasm.memory, wasm.alloc, motionBytes).ptr
  const positionsPtr = allocBytes(wasm.memory, wasm.alloc, positionsBytes).ptr
  const velocitiesPtr = allocBytes(wasm.memory, wasm.alloc, positionsBytes).ptr
  const accelerationsPtr = allocBytes(wasm.memory, wasm.alloc, positionsBytes).ptr
  const agesPtr = allocBytes(wasm.memory, wasm.alloc, agesBytes).ptr
  const nextLinkPtr = allocBytes(wasm.memory, wasm.alloc, count * 4).ptr
  const gridHeadPtr = allocBytes(wasm.memory, wasm.alloc, gridHeadBytes).ptr

  wasm.initMotionState(
    sourcePositionsPtr,
    motionPathPtr,
    positionsPtr,
    velocitiesPtr,
    accelerationsPtr,
    agesPtr,
    count,
  )

  let nextFrame = 1
  let backwardCursor = 0
  let forwardCursor = 0

  return {
    count,
    frameCount,
    stepFrames(chunkFrames = 1) {
      const totalFrames = Math.max(0, frameCount - 1)
      if (!totalFrames) {
        return {
          done: true,
          completedFrames: 0,
          totalFrames,
          progress: 1,
        }
      }

      if (nextFrame >= frameCount) {
        return {
          done: true,
          completedFrames: totalFrames,
          totalFrames,
          progress: 1,
        }
      }

      const safeChunk = Math.max(1, Math.round(Number(chunkFrames) || 1))
      const frameEnd = Math.min(frameCount, nextFrame + safeChunk)

      wasm.simulateMotionFrames(
        targetPositionsPtr,
        motionPathPtr,
        positionsPtr,
        velocitiesPtr,
        accelerationsPtr,
        agesPtr,
        nextLinkPtr,
        gridHeadPtr,
        width,
        height,
        columns,
        rows,
        count,
        nextFrame,
        frameEnd,
        2,
      )

      nextFrame = frameEnd
      const completedFrames = Math.max(0, nextFrame - 1)

      return {
        done: nextFrame >= frameCount,
        completedFrames,
        totalFrames,
        progress: totalFrames > 0 ? completedFrames / totalFrames : 1,
      }
    },
    settleBackward(chunkCells = count) {
      if (backwardCursor >= count) {
        return {
          done: true,
          completedCells: count,
          totalCells: count,
          progress: 1,
        }
      }

      const safeChunk = Math.max(1, Math.round(Number(chunkCells) || 1))
      const cellEnd = Math.min(count, backwardCursor + safeChunk)

      wasm.settleMotionBackward(
        sourcePositionsPtr,
        targetPositionsPtr,
        motionPathPtr,
        width,
        height,
        columns,
        rows,
        count,
        frameCount,
        backwardCursor,
        cellEnd,
      )

      backwardCursor = cellEnd

      return {
        done: backwardCursor >= count,
        completedCells: backwardCursor,
        totalCells: count,
        progress: count > 0 ? backwardCursor / count : 1,
      }
    },
    settleForward(chunkCells = count) {
      if (forwardCursor >= count) {
        return {
          done: true,
          completedCells: count,
          totalCells: count,
          progress: 1,
        }
      }

      const safeChunk = Math.max(1, Math.round(Number(chunkCells) || 1))
      const cellEnd = Math.min(count, forwardCursor + safeChunk)

      wasm.settleMotionForward(
        motionPathPtr,
        width,
        height,
        columns,
        rows,
        count,
        frameCount,
        forwardCursor,
        cellEnd,
      )

      forwardCursor = cellEnd

      return {
        done: forwardCursor >= count,
        completedCells: forwardCursor,
        totalCells: count,
        progress: count > 0 ? forwardCursor / count : 1,
      }
    },
    finalize() {
      return new Float32Array(wasm.memory.buffer, motionPathPtr, motionBytes / 4).slice()
    },
  }
}
