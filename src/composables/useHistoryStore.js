const DB_NAME = 'pixmove-history-db'
const DB_VERSION = 1
const STORE_NAME = 'morph_history'
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
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('打开 IndexedDB 失败。'))
  })

  return databasePromise
}

const withStore = async (mode, callback) => {
  const db = await openDb()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode)
    const store = transaction.objectStore(STORE_NAME)

    let result = null

    transaction.oncomplete = () => resolve(result)
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 操作失败。'))

    result = callback(store)
  })
}

export const saveHistoryRecord = async (record) => {
  await withStore('readwrite', (store) => {
    store.put(record)
  })
}

export const deleteHistoryRecord = async (id) => {
  await withStore('readwrite', (store) => {
    store.delete(id)
  })
}

export const clearHistoryRecords = async () => {
  await withStore('readwrite', (store) => {
    store.clear()
  })
}

export const loadHistoryRecords = async (limit = 24) => {
  const db = await openDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const request = store.getAll()

    request.onsuccess = () => {
      const rows = (request.result || [])
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, limit)

      resolve(rows)
    }

    request.onerror = () => reject(request.error || new Error('读取历史记录失败。'))
  })
}

export const pruneHistory = async (maxCount = 24) => {
  const records = await loadHistoryRecords(Number.MAX_SAFE_INTEGER)

  if (records.length <= maxCount) return

  const overflow = records.slice(maxCount)

  await Promise.all(
    overflow.map((item) =>
      withStore('readwrite', (store) => {
        store.delete(item.id)
      }),
    ),
  )
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
