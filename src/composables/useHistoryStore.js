const DB_NAME = 'pixmove-history-db'
const DB_VERSION = 2
const STORE_NAME = 'morph_history'
const SUMMARY_STORE_NAME = 'morph_history_summary'
const PREFS_KEY = 'pixmove-ui-prefs'

let databasePromise = null

const openDb = () => {
  if (databasePromise) return databasePromise

  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB。'))
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }

      if (!db.objectStoreNames.contains(SUMMARY_STORE_NAME)) {
        const summaryStore = db.createObjectStore(SUMMARY_STORE_NAME, { keyPath: 'id' })
        summaryStore.createIndex('createdAt', 'createdAt', { unique: false })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('打开 IndexedDB 失败。'))
  })

  return databasePromise
}

const withStores = async (storeNames, mode, callback) => {
  const db = await openDb()
  const names = Array.isArray(storeNames) ? storeNames : [storeNames]

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(names, mode)
    const stores = Object.fromEntries(
      names.map((name) => [name, transaction.objectStore(name)]),
    )

    let result = null

    transaction.oncomplete = () => resolve(result)
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 操作失败。'))

    result = callback(stores, transaction)
  })
}

const measureBytes = (value) => {
  if (value == null) return 0

  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (!text) return 0

  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text).length
  }

  return text.length * 2
}

const measureStringBytesFast = (value) =>
  typeof value === 'string' ? value.length * 2 : measureBytes(value)

const isTypedArrayLike = (value) =>
  ArrayBuffer.isView(value)

const getBinaryByteLength = (value) => {
  if (value == null) return 0

  if (isTypedArrayLike(value)) {
    return Number(value.byteLength) || 0
  }

  if (value instanceof ArrayBuffer) {
    return Number(value.byteLength) || 0
  }

  return 0
}

const estimateMorphDataBytes = (morphData) => {
  if (!morphData || typeof morphData !== 'object') return 0

  let bytes = 0

  bytes += measureStringBytesFast(morphData.sourceRasterUrl)
  bytes += measureStringBytesFast(morphData.targetRasterUrl)
  bytes += measureBytes({
    width: morphData.width,
    height: morphData.height,
    createdAt: morphData.createdAt,
    sourceAverage: morphData.sourceAverage,
    targetAverage: morphData.targetAverage,
    meta: morphData.meta,
  })

  const grid = morphData.grid

  if (grid && typeof grid === 'object') {
    bytes += measureBytes({
      columns: grid.columns ?? grid.side,
      rows: grid.rows ?? grid.side,
      count: grid.count,
      frameCount: grid.frameCount,
    })

    bytes += getBinaryByteLength(grid.cellBounds)
    bytes += getBinaryByteLength(grid.sourceColors)
    bytes += getBinaryByteLength(grid.targetColors)
    bytes += getBinaryByteLength(grid.targetToSource)
    bytes += getBinaryByteLength(grid.sourceToTarget)
    bytes += getBinaryByteLength(grid.sourcePositions)
    bytes += getBinaryByteLength(grid.targetPositions)
    bytes += getBinaryByteLength(grid.motionPath)
  }

  return bytes
}

const buildHistorySummary = (record) => ({
  id: record.id,
  createdAt: record.createdAt,
  sourceName: record.sourceName,
  targetName: record.targetName,
  pointCount: record.pointCount,
  rendererMode: record.rendererMode,
  durationSeconds: record.durationSeconds,
  sampleDensity: record.sampleDensity,
  keyframes: Array.isArray(record.keyframes) ? record.keyframes : [],
  exportSettings: record.exportSettings || {},
  thumbnail: record.thumbnail || '',
  sourceUrlBytes: measureStringBytesFast(record.sourceUrl),
  targetUrlBytes: measureStringBytesFast(record.targetUrl),
  thumbnailBytes: measureStringBytesFast(record.thumbnail),
  morphDataBytes: estimateMorphDataBytes(record.morphData),
})

const loadFromCursor = async (storeName, limit = 24, mapValue = (value) => value) => {
  const db = await openDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const store = tx.objectStore(storeName)
    const index = store.index('createdAt')
    const request = index.openCursor(null, 'prev')
    const rows = []
    const maxCount = Number.isFinite(Number(limit)) ? Number(limit) : Number.MAX_SAFE_INTEGER

    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor || rows.length >= maxCount) {
        resolve(rows)
        return
      }

      const mapped = mapValue(cursor.value, cursor)
      if (mapped != null) {
        rows.push(mapped)
      }
      cursor.continue()
    }

    request.onerror = () => reject(request.error || new Error('读取历史记录失败。'))
  })
}

const loadDetailRecordIds = async (limit = Number.MAX_SAFE_INTEGER) => {
  const db = await openDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const index = store.index('createdAt')
    const request = index.openKeyCursor(null, 'prev')
    const ids = []
    const maxCount = Number.isFinite(Number(limit)) ? Number(limit) : Number.MAX_SAFE_INTEGER

    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor || ids.length >= maxCount) {
        resolve(ids)
        return
      }

      ids.push(String(cursor.primaryKey))
      cursor.continue()
    }

    request.onerror = () => reject(request.error || new Error('读取历史记录索引失败。'))
  })
}

const backfillSummariesFromDetails = async (limit = 24, existing = []) => {
  const existingIds = new Set(existing.map((item) => item.id))
  const missingCount = Math.max(0, limit - existing.length)
  const rows = await loadFromCursor(STORE_NAME, missingCount, (record) => {
    if (!record?.id || existingIds.has(record.id)) return null
    return buildHistorySummary(record)
  })

  if (rows.length > 0) {
    await withStores(SUMMARY_STORE_NAME, 'readwrite', (stores) => {
      const summaryStore = stores[SUMMARY_STORE_NAME]
      rows.forEach((row) => summaryStore.put(row))
    })
  }

  return rows
}

export const saveHistoryRecord = async (record) => {
  const summary = buildHistorySummary(record)

  await withStores([STORE_NAME, SUMMARY_STORE_NAME], 'readwrite', (stores) => {
    stores[STORE_NAME].put(record)
    stores[SUMMARY_STORE_NAME].put(summary)
  })
}

export const deleteHistoryRecord = async (id) => {
  await withStores([STORE_NAME, SUMMARY_STORE_NAME], 'readwrite', (stores) => {
    stores[STORE_NAME].delete(id)
    stores[SUMMARY_STORE_NAME].delete(id)
  })
}

export const clearHistoryRecords = async () => {
  await withStores([STORE_NAME, SUMMARY_STORE_NAME], 'readwrite', (stores) => {
    stores[STORE_NAME].clear()
    stores[SUMMARY_STORE_NAME].clear()
  })
}

export const loadHistorySummaries = async (limit = 24) => {
  const maxCount = Number.isFinite(Number(limit)) ? Number(limit) : 24
  const summaryRows = await loadFromCursor(SUMMARY_STORE_NAME, maxCount)

  if (summaryRows.length >= maxCount) {
    return summaryRows
  }

  const fallbackRows = await backfillSummariesFromDetails(maxCount, summaryRows)

  return [...summaryRows, ...fallbackRows]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, maxCount)
}

export const loadHistoryRecord = async (id) => {
  if (!id) return null

  return withStores(STORE_NAME, 'readonly', (stores) =>
    new Promise((resolve, reject) => {
      const request = stores[STORE_NAME].get(id)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error || new Error('读取历史详情失败。'))
    }),
  )
}

export const pruneHistory = async (maxCount = 24) => {
  const ids = await loadDetailRecordIds(Number.MAX_SAFE_INTEGER)

  if (ids.length <= maxCount) return

  const overflow = ids.slice(maxCount)

  await withStores([STORE_NAME, SUMMARY_STORE_NAME], 'readwrite', (stores) => {
    overflow.forEach((id) => {
      stores[STORE_NAME].delete(id)
      stores[SUMMARY_STORE_NAME].delete(id)
    })
  })
}

export const saveUiPrefs = (prefs) => {
  if (typeof localStorage === 'undefined') return

  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Ignore quota errors, app can continue without prefs.
  }
}

export const loadUiPrefs = () => {
  if (typeof localStorage === 'undefined') return null

  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}
