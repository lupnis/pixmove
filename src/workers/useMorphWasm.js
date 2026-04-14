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
      computeAssignments: exports.computeAssignments,
      simulateMotion: exports.simulateMotion,
    }
  })()

  return wasmPromise
}

const writeBytes = (memory, alloc, bytes) => {
  const ptr = alloc(bytes.byteLength)
  new Uint8Array(memory.buffer, ptr, bytes.byteLength).set(bytes)
  return ptr
}

const allocBytes = (memory, alloc, size) => {
  const ptr = alloc(size)
  return {
    ptr,
    view: new Uint8Array(memory.buffer, ptr, size),
  }
}

export const computeAssignmentsWasm = async (
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
  const targetWeightsPtr = writeBytes(wasm.memory, wasm.alloc, new Uint8Array(targetWeights.buffer, targetWeights.byteOffset, targetWeights.byteLength))
  const targetToSourcePtr = allocBytes(wasm.memory, wasm.alloc, count * 4).ptr
  const sourceToTargetPtr = allocBytes(wasm.memory, wasm.alloc, count * 4).ptr
  const heuristicsPtr = allocBytes(wasm.memory, wasm.alloc, count * 8).ptr
  const statsPtr = allocBytes(wasm.memory, wasm.alloc, 8).ptr

  wasm.computeAssignments(
    sourceColorsPtr,
    targetColorsPtr,
    targetWeightsPtr,
    targetToSourcePtr,
    sourceToTargetPtr,
    heuristicsPtr,
    statsPtr,
    columns,
    rows,
    count,
    proximityFactor,
    maxGenerations,
    swapsPerGeneration,
  )

  return {
    targetToSource: new Uint32Array(wasm.memory.buffer, targetToSourcePtr, count).slice(),
    sourceToTarget: new Uint32Array(wasm.memory.buffer, sourceToTargetPtr, count).slice(),
    stats: new Int32Array(wasm.memory.buffer, statsPtr, 2).slice(),
  }
}

export const simulateMotionWasm = async (
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

  wasm.simulateMotion(
    sourcePositionsPtr,
    targetPositionsPtr,
    motionPathPtr,
    width,
    height,
    columns,
    rows,
    count,
    frameCount,
    2,
  )

  return new Float32Array(wasm.memory.buffer, motionPathPtr, (motionBytes / 4)).slice()
}
