<script setup>
import { animate } from 'animejs'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import HistoryPanel from './components/HistoryPanel.vue'
import ImagePairPanel from './components/ImagePairPanel.vue'
import AnimationPanel from './components/AnimationPanel.vue'
import StatusBar from './components/StatusBar.vue'
import { builtInTemplates } from './data/templates'
import {
  buildMorphData,
  DEFAULT_RENDERER_MODE,
  DEFAULT_MORPH_HEIGHT,
  DEFAULT_MORPH_WIDTH,
  MAX_RESOLUTION_PERCENT,
  MIN_RESOLUTION_PERCENT,
  normalizeRendererMode,
  renderMorphThumbnail,
  resolveCellResolution,
} from './composables/useMorphEngine'
import {
  clearHistoryRecords,
  deleteHistoryRecord,
  loadHistoryRecords,
  loadUiPrefs,
  pruneHistory,
  saveHistoryRecord,
  saveUiPrefs,
} from './composables/useHistoryStore'
import { buildDefaultGifFilename, downloadBlob, exportMorphAsGif } from './composables/useVideoExporter'
import {
  applyComponentTonePalette,
  COMPONENT_TONE_OPTIONS,
  DEFAULT_COMPONENT_TONE,
  DEFAULT_LANGUAGE_MODE,
  DEFAULT_THEME_MODE,
  LANGUAGE_MODE_OPTIONS,
  normalizeComponentTone,
  normalizeLanguageMode,
  normalizeThemeMode,
  resolveAppliedLanguage,
  resolveOptionLabel,
  THEME_MODE_OPTIONS,
} from './config/uiSettings'
import { useI18n } from './i18n/useI18n'
import { RENDERER_MODE_OPTIONS } from './utils/renderModes'
import { clamp, formatSeconds, uid } from './utils/format'
import { evaluateTimeline, makeDefaultKeyframes, normalizeKeyframes } from './utils/timeline'

const { locale, t, setLocale } = useI18n()

const sourceImage = ref({ name: '', url: '' })
const initialTemplate = builtInTemplates[0]
const targetImage = ref({
  name: initialTemplate?.name || '',
  url: initialTemplate?.src || '',
})

const selectedTemplateId = ref(initialTemplate?.id || '')
const sampleDensity = ref(8)
const sourceResolutionBase = ref({
  width: DEFAULT_MORPH_WIDTH,
  height: DEFAULT_MORPH_HEIGHT,
})
const targetResolutionBase = ref({
  width: DEFAULT_MORPH_WIDTH,
  height: DEFAULT_MORPH_HEIGHT,
})

const morphData = ref(null)
const timelineTime = ref(0)
const morphProgress = ref(0)
const durationSeconds = ref(4)
const keyframes = ref(makeDefaultKeyframes())

const exportSettings = ref({
  resolution: 'native',
  fps: 24,
})

const isPlaying = ref(false)
const busy = ref(false)
const isGenerating = ref(false)

const statusText = ref('')
const stageText = ref('')
const statusMessageSpec = ref(null)
const statusStageSpec = ref(null)
const pipelineProgress = ref(0)
const themeMode = ref(DEFAULT_THEME_MODE)
const componentTone = ref(DEFAULT_COMPONENT_TONE)
const languageMode = ref(DEFAULT_LANGUAGE_MODE)
const settingsOpen = ref(false)
const settingsDialogVisible = ref(false)
const settingsContentVisible = ref(false)
const settingsActiveTab = ref('appearance')
const settingsDraftTheme = ref(DEFAULT_THEME_MODE)
const settingsDraftTone = ref(DEFAULT_COMPONENT_TONE)
const settingsDraftLanguage = ref(DEFAULT_LANGUAGE_MODE)
const rendererMode = ref(DEFAULT_RENDERER_MODE)
const settingsDraftRenderer = ref(DEFAULT_RENDERER_MODE)
const showClearRecordsConfirm = ref(false)
const isClearingRecords = ref(false)
const systemPrefersDark = ref(true)

const historyCollapsed = ref(false)
const historyItems = ref([])
const activeHistoryId = ref('')
const exportingId = ref('')
const isLoadingHistory = ref(true)
const mainLayoutRef = ref(null)
const centerLayoutRef = ref(null)
const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1440)
const historyPanelWidth = ref(216)
const imagePanelWidth = ref(320)

const HISTORY_PANEL_MIN = 160
const HISTORY_PANEL_MAX = 320
const HISTORY_PANEL_COLLAPSED = 70
const IMAGE_PANEL_MIN = 240
const IMAGE_PANEL_MAX = 620
const PREVIEW_PANEL_MIN = 340
const HISTORY_SPLITTER_SIZE = 4
const CENTER_SPLITTER_SIZE = 8
const MOBILE_BREAKPOINT = 840
const HISTORY_REMOVE_EXIT_DURATION = 240
const SETTINGS_CONTENT_FADE_DURATION = 180
const SETTINGS_SHELL_TRANSITION_DURATION = 240
const SETTINGS_ANIMATION_DELAY = 24

const positionText = computed(() => {
  const current = timelineTime.value * durationSeconds.value
  return `${formatSeconds(current)} / ${formatSeconds(durationSeconds.value)}`
})

const hasReadyPair = computed(() => Boolean(sourceImage.value.url && targetImage.value.url))
const canStopProcessing = computed(() => isGenerating.value || Boolean(exportingId.value))
const canExportActive = computed(() => {
  if (!morphData.value || !activeHistoryId.value) return false
  return historyItems.value.some((item) => item.id === activeHistoryId.value)
})
const isExportingActive = computed(() => Boolean(activeHistoryId.value && exportingId.value === activeHistoryId.value))
const stopActionLabel = computed(() => {
  if (isGenerating.value) return t('workflow.stopGenerate')
  if (exportingId.value) return t('workflow.stopExport')
  return t('workflow.stop')
})
const isCompactLayout = computed(() => viewportWidth.value <= MOBILE_BREAKPOINT)

const browserLanguageCandidates = () => {
  if (typeof navigator === 'undefined') return []

  const languages = Array.isArray(navigator.languages) ? navigator.languages : []
  const fallback = navigator.language ? [navigator.language] : []

  return [...languages, ...fallback]
}

const applyLanguageMode = (mode) => {
  const normalized = normalizeLanguageMode(mode)
  const applied = resolveAppliedLanguage(normalized, browserLanguageCandidates())

  setLocale(applied)

  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('lang', applied)
    document.documentElement.setAttribute('data-language-mode', normalized)
  }
}

const resolveThemeModeDisplayLabel = (modeOption) =>
  resolveOptionLabel(modeOption, locale.value)

const resolveToneDisplayLabel = (toneOption) =>
  resolveOptionLabel(toneOption, locale.value)

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

const formatBytes = (bytes) => {
  const value = Math.max(0, Number(bytes) || 0)

  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

const resolveErrorMessage = (error) => {
  if (typeof error === 'string') return error
  if (error?.message) return error.message
  if (error?.name && error.name !== 'Error') return error.name

  try {
    const serialized = JSON.stringify(error)
    if (serialized && serialized !== '{}' && serialized !== 'null') return serialized
  } catch {
    // Ignore serialization failures for opaque browser errors.
  }

  return t('workflow.unknownError')
}

const i18nText = (key, params) => ({ type: 'i18n', key, params })

const isI18nText = (value) => Boolean(value && typeof value === 'object' && value.type === 'i18n' && typeof value.key === 'string')

const resolveI18nParam = (value) => {
  if (isI18nText(value)) return resolveTextSpec(value)

  if (Array.isArray(value)) {
    return value.map((entry) => resolveI18nParam(entry))
  }

  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveI18nParam(entry)]),
    )
  }

  return value
}

const resolveTextSpec = (value) => {
  if (isI18nText(value)) {
    return t(value.key, resolveI18nParam(value.params))
  }

  return value == null ? '' : String(value)
}

const refreshStatusText = () => {
  statusText.value = resolveTextSpec(statusMessageSpec.value)
  stageText.value = resolveTextSpec(statusStageSpec.value)
}

const cacheStats = ref({
  totalBytes: 0,
  totalReadable: '0 B',
  segments: [],
  recordCount: 0,
})
const cacheStatsLoading = ref(false)
let cacheStatsTaskId = 0

const CACHE_STATS_BATCH_SIZE = 2

const yieldToMainThread = () =>
  new Promise((resolve) => {
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => resolve(), { timeout: 24 })
      return
    }

    setTimeout(resolve, 0)
  })

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
      side: grid.side,
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

const cancelCacheStatsRefresh = () => {
  cacheStatsTaskId += 1
  cacheStatsLoading.value = false
}

const isCacheStatsTaskActive = (taskId) =>
  taskId === cacheStatsTaskId
  && settingsOpen.value
  && settingsActiveTab.value === 'cache'

const buildCacheStats = async (taskId) => {
  const items = [...historyItems.value]

  let sourceBytes = 0
  let targetBytes = 0
  let thumbnailBytes = 0
  let morphBytes = 0
  let metadataBytes = 0

  for (let index = 0; index < items.length; index += 1) {
    if (!isCacheStatsTaskActive(taskId)) return null

    const item = items[index]

    sourceBytes += measureStringBytesFast(item.sourceUrl)
    targetBytes += measureStringBytesFast(item.targetUrl)
    thumbnailBytes += measureStringBytesFast(item.thumbnail)
    morphBytes += estimateMorphDataBytes(item.morphData)

    metadataBytes += measureBytes({
      id: item.id,
      createdAt: item.createdAt,
      sourceName: item.sourceName,
      targetName: item.targetName,
      pointCount: item.pointCount,
      rendererMode: item.rendererMode,
      durationSeconds: item.durationSeconds,
      sampleDensity: item.sampleDensity,
      keyframes: item.keyframes,
      exportSettings: item.exportSettings,
    })

    if ((index + 1) % CACHE_STATS_BATCH_SIZE === 0) {
      await yieldToMainThread()
    }
  }

  if (!isCacheStatsTaskActive(taskId)) return null

  const prefsBytes = measureBytes({
    selectedTemplateId: selectedTemplateId.value,
    themeMode: themeMode.value,
    componentTone: componentTone.value,
    languageMode: languageMode.value,
    rendererMode: rendererMode.value,
    sampleDensity: sampleDensity.value,
    durationSeconds: durationSeconds.value,
    keyframes: keyframes.value,
    exportSettings: exportSettings.value,
    historyCollapsed: historyCollapsed.value,
    layoutSizes: {
      historyPanelWidth: Math.round(historyPanelWidth.value),
      imagePanelWidth: Math.round(imagePanelWidth.value),
    },
  })

  const rows = [
    {
      key: 'source',
      label: t('settings.cache.categories.source'),
      bytes: sourceBytes,
      color: 'var(--cache-source)',
    },
    {
      key: 'target',
      label: t('settings.cache.categories.target'),
      bytes: targetBytes,
      color: 'var(--cache-target)',
    },
    {
      key: 'thumbnail',
      label: t('settings.cache.categories.thumbnail'),
      bytes: thumbnailBytes,
      color: 'var(--cache-thumbnail)',
    },
    {
      key: 'morph',
      label: t('settings.cache.categories.morph'),
      bytes: morphBytes,
      color: 'var(--cache-morph)',
    },
    {
      key: 'metadata',
      label: t('settings.cache.categories.metadata'),
      bytes: metadataBytes,
      color: 'var(--cache-metadata)',
    },
    {
      key: 'prefs',
      label: t('settings.cache.categories.prefs'),
      bytes: prefsBytes,
      color: 'var(--cache-prefs)',
    },
  ]

  const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0)
  const segments = rows
    .filter((row) => row.bytes > 0)
    .map((row) => ({
      ...row,
      percent: totalBytes > 0 ? (row.bytes / totalBytes) * 100 : 0,
      readable: formatBytes(row.bytes),
    }))

  return {
    totalBytes,
    totalReadable: formatBytes(totalBytes),
    segments,
    recordCount: items.length,
  }
}

const refreshCacheStats = async () => {
  const taskId = ++cacheStatsTaskId
  cacheStatsLoading.value = true

  await nextTick()

  try {
    const nextStats = await buildCacheStats(taskId)
    if (!nextStats || taskId !== cacheStatsTaskId) return
    cacheStats.value = nextStats
  } finally {
    if (taskId === cacheStatsTaskId) {
      cacheStatsLoading.value = false
    }
  }
}

const cacheBarAnimationKey = computed(() => {
  const stats = cacheStats.value
  const signature = stats.segments
    .map((segment) => `${segment.key}:${Math.round(segment.percent * 100)}`)
    .join('|')

  return `${stats.totalBytes}:${signature}`
})

const cacheStatsRefreshFingerprint = computed(() => [
  historyItems.value.length,
  historyItems.value.map((item) => `${item.id}:${item.createdAt}`).join(','),
  selectedTemplateId.value,
  themeMode.value,
  componentTone.value,
  languageMode.value,
  rendererMode.value,
  sampleDensity.value,
  durationSeconds.value,
  keyframes.value.length,
  exportSettings.value.resolution,
  exportSettings.value.fps,
  historyCollapsed.value,
  Math.round(historyPanelWidth.value),
  Math.round(imagePanelWidth.value),
  locale.value,
].join('|'))

watch(
  [settingsOpen, settingsActiveTab, cacheStatsRefreshFingerprint],
  ([open, tab]) => {
    if (!open || tab !== 'cache') {
      cancelCacheStatsRefresh()
      return
    }

    refreshCacheStats()
  }
)

const canClearAllRecords = computed(() =>
  historyItems.value.length > 0 && !busy.value && !isClearingRecords.value,
)

const closeClearRecordsConfirm = () => {
  showClearRecordsConfirm.value = false
}

const openClearRecordsConfirm = () => {
  if (!canClearAllRecords.value) return
  showClearRecordsConfirm.value = true
}

const clearAllHistoryData = async () => {
  if (!canClearAllRecords.value) return

  isClearingRecords.value = true

  try {
    await clearHistoryRecords()
    historyItems.value = []
    activeHistoryId.value = ''
    exportingId.value = ''
    closeClearRecordsConfirm()
    clearWorkspace(t('workflow.recordsCleared'))
  } catch (error) {
    setStatus(
      i18nText('workflow.clearRecordsFailed', {
        message: error?.message || t('workflow.unknownError'),
      }),
      i18nText('workflow.error'),
    )
  } finally {
    isClearingRecords.value = false
  }
}

const mainLayoutStyle = computed(() => {
  if (isCompactLayout.value) return null

  return {
    gridTemplateColumns: `${historyCollapsed.value ? HISTORY_PANEL_COLLAPSED : Math.round(historyPanelWidth.value)}px ${historyCollapsed.value ? 0 : HISTORY_SPLITTER_SIZE}px minmax(0, 1fr)`,
  }
})

const centerLayoutStyle = computed(() => {
  if (isCompactLayout.value) return null

  return {
    gridTemplateColumns: `${Math.round(imagePanelWidth.value)}px ${CENTER_SPLITTER_SIZE}px minmax(0, 1fr)`,
  }
})

const densityMax = computed(() => {
  return MAX_RESOLUTION_PERCENT
})

const effectiveResolution = computed(() =>
  resolveCellResolution(
    targetResolutionBase.value.width,
    targetResolutionBase.value.height,
    sampleDensity.value,
    densityMax.value,
  ),
)

let timelineAnimation = null
let progressAnimation = null
let prefsTimer = null
let sourceResolutionTaskId = 0
let targetResolutionTaskId = 0
let generatePulseTimer = null
let lastGenerateProgress = 0
let lastGeneratePhase = ''
let paneResizeSession = null
let generateAbortController = null
let exportAbortController = null
let systemThemeMedia = null
let settingsDialogTimer = null
let settingsContentTimer = null
let settingsUnmountTimer = null
const historyRemoveTimers = new Map()

const resolveAppliedTheme = (mode) => {
  const normalized = normalizeThemeMode(mode)
  if (normalized === 'system') {
    return systemPrefersDark.value ? 'dark' : 'light'
  }

  return normalized
}

const applyThemeMode = (mode) => {
  if (typeof document === 'undefined') return

  const normalized = normalizeThemeMode(mode)
  const applied = resolveAppliedTheme(normalized)
  document.documentElement.setAttribute('data-theme', applied)
  document.documentElement.setAttribute('data-theme-mode', normalized)
}

const applyComponentTone = (tone) => {
  if (typeof document === 'undefined') return

  const normalized = normalizeComponentTone(tone)
  document.documentElement.setAttribute('data-accent-tone', normalized)
  applyComponentTonePalette(normalized, document.documentElement)
}

const clearSettingsAnimationTimers = () => {
  if (settingsDialogTimer) {
    clearTimeout(settingsDialogTimer)
    settingsDialogTimer = null
  }

  if (settingsContentTimer) {
    clearTimeout(settingsContentTimer)
    settingsContentTimer = null
  }

  if (settingsUnmountTimer) {
    clearTimeout(settingsUnmountTimer)
    settingsUnmountTimer = null
  }
}

const playSettingsEnterAnimation = async () => {
  clearSettingsAnimationTimers()
  settingsDialogVisible.value = false
  settingsContentVisible.value = false

  await nextTick()

  settingsDialogTimer = setTimeout(() => {
    settingsDialogVisible.value = true
    settingsDialogTimer = null
  }, SETTINGS_ANIMATION_DELAY)

  settingsContentTimer = setTimeout(() => {
    settingsContentVisible.value = true
    settingsContentTimer = null
  }, SETTINGS_SHELL_TRANSITION_DURATION + SETTINGS_ANIMATION_DELAY)
}

const closeSettingsDialog = () => {
  clearSettingsAnimationTimers()
  settingsContentVisible.value = false

  settingsDialogTimer = setTimeout(() => {
    settingsDialogVisible.value = false
    settingsDialogTimer = null
  }, SETTINGS_CONTENT_FADE_DURATION)

  settingsUnmountTimer = setTimeout(() => {
    settingsOpen.value = false
    settingsUnmountTimer = null
  }, SETTINGS_CONTENT_FADE_DURATION + SETTINGS_SHELL_TRANSITION_DURATION)
}

const openSettings = async () => {
  closeClearRecordsConfirm()
  settingsDraftTheme.value = themeMode.value
  settingsDraftTone.value = componentTone.value
  settingsDraftLanguage.value = languageMode.value
  settingsDraftRenderer.value = rendererMode.value
  settingsActiveTab.value = 'appearance'
  settingsOpen.value = true
  await playSettingsEnterAnimation()
}

const cancelSettings = () => {
  closeClearRecordsConfirm()
  settingsDraftTheme.value = themeMode.value
  settingsDraftTone.value = componentTone.value
  settingsDraftLanguage.value = languageMode.value
  settingsDraftRenderer.value = rendererMode.value
  applyThemeMode(themeMode.value)
  applyComponentTone(componentTone.value)
  applyLanguageMode(languageMode.value)
  closeSettingsDialog()
}

const confirmSettings = () => {
  closeClearRecordsConfirm()
  themeMode.value = normalizeThemeMode(settingsDraftTheme.value)
  componentTone.value = normalizeComponentTone(settingsDraftTone.value)
  languageMode.value = normalizeLanguageMode(settingsDraftLanguage.value)
  rendererMode.value = normalizeRendererMode(settingsDraftRenderer.value)
  closeSettingsDialog()
}

const onSystemThemeChange = (event) => {
  systemPrefersDark.value = Boolean(event?.matches)
}

const createAbortError = (message = t('workflow.operationStopped')) => {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

const resolveHistoryPanelMax = () => {
  const total = mainLayoutRef.value?.clientWidth || viewportWidth.value
  const safeMax = total - (
    IMAGE_PANEL_MIN + PREVIEW_PANEL_MIN + CENTER_SPLITTER_SIZE + HISTORY_SPLITTER_SIZE + 20
  )
  return clamp(safeMax, HISTORY_PANEL_MIN, HISTORY_PANEL_MAX)
}

const resolveImagePanelMax = () => {
  const total = centerLayoutRef.value?.clientWidth || (viewportWidth.value - historyPanelWidth.value)
  const safeMax = total - PREVIEW_PANEL_MIN - CENTER_SPLITTER_SIZE
  return clamp(safeMax, IMAGE_PANEL_MIN, IMAGE_PANEL_MAX)
}

const clampLayoutWidths = () => {
  historyPanelWidth.value = clamp(historyPanelWidth.value, HISTORY_PANEL_MIN, resolveHistoryPanelMax())
  imagePanelWidth.value = clamp(imagePanelWidth.value, IMAGE_PANEL_MIN, resolveImagePanelMax())
}

const onViewportResize = () => {
  viewportWidth.value = window.innerWidth

  if (!isCompactLayout.value) {
    clampLayoutWidths()
  }
}

const stopPaneResize = () => {
  if (!paneResizeSession) return

  paneResizeSession = null
  document.body.classList.remove('is-layout-resizing')
  window.removeEventListener('pointermove', onPaneResizeMove)
  window.removeEventListener('pointerup', stopPaneResize)
  window.removeEventListener('pointercancel', stopPaneResize)
}

const onPaneResizeMove = (event) => {
  if (!paneResizeSession) return

  const deltaX = event.clientX - paneResizeSession.startX

  if (paneResizeSession.pane === 'history') {
    historyPanelWidth.value = clamp(
      paneResizeSession.startHistoryWidth + deltaX,
      HISTORY_PANEL_MIN,
      resolveHistoryPanelMax(),
    )

    imagePanelWidth.value = clamp(imagePanelWidth.value, IMAGE_PANEL_MIN, resolveImagePanelMax())
    return
  }

  if (paneResizeSession.pane === 'image') {
    imagePanelWidth.value = clamp(
      paneResizeSession.startImageWidth + deltaX,
      IMAGE_PANEL_MIN,
      resolveImagePanelMax(),
    )
  }
}

const startPaneResize = (pane, event) => {
  if (isCompactLayout.value) return
  if (pane === 'history' && historyCollapsed.value) return

  event.preventDefault()

  paneResizeSession = {
    pane,
    startX: event.clientX,
    startHistoryWidth: historyPanelWidth.value,
    startImageWidth: imagePanelWidth.value,
  }

  document.body.classList.add('is-layout-resizing')
  window.addEventListener('pointermove', onPaneResizeMove)
  window.addEventListener('pointerup', stopPaneResize)
  window.addEventListener('pointercancel', stopPaneResize)
}

const readImageSize = (url) =>
  new Promise((resolve, reject) => {
    if (!url) {
      resolve({ width: DEFAULT_MORPH_WIDTH, height: DEFAULT_MORPH_HEIGHT })
      return
    }

    const image = new Image()
    image.onload = () => {
      resolve({
        width: Math.max(2, image.naturalWidth || image.width || DEFAULT_MORPH_WIDTH),
        height: Math.max(2, image.naturalHeight || image.height || DEFAULT_MORPH_HEIGHT),
      })
    }
    image.onerror = () => reject(new Error(t('workflow.readTargetSizeFailed')))
    image.src = url
  })

const refreshTargetResolutionBase = async (url) => {
  const taskId = ++targetResolutionTaskId

  try {
    const size = await readImageSize(url)
    if (taskId !== targetResolutionTaskId) return
    targetResolutionBase.value = size
  } catch {
    if (taskId !== targetResolutionTaskId) return
    targetResolutionBase.value = {
      width: DEFAULT_MORPH_WIDTH,
      height: DEFAULT_MORPH_HEIGHT,
    }
  }
}

const refreshSourceResolutionBase = async (url) => {
  const taskId = ++sourceResolutionTaskId

  try {
    const size = await readImageSize(url)
    if (taskId !== sourceResolutionTaskId) return
    sourceResolutionBase.value = size
  } catch {
    if (taskId !== sourceResolutionTaskId) return
    sourceResolutionBase.value = {
      width: DEFAULT_MORPH_WIDTH,
      height: DEFAULT_MORPH_HEIGHT,
    }
  }
}

const syncMorphProgress = () => {
  morphProgress.value = evaluateTimeline(keyframes.value, timelineTime.value)
}

watch(
  () => timelineTime.value,
  () => {
    syncMorphProgress()
  },
)

watch(
  () => keyframes.value,
  () => {
    syncMorphProgress()
  },
  { deep: true },
)

watch(
  () => targetImage.value.url,
  (url) => {
    refreshTargetResolutionBase(url)
  },
  { immediate: true },
)

watch(
  () => sourceImage.value.url,
  (url) => {
    refreshSourceResolutionBase(url)
  },
  { immediate: true },
)

watch(
  () => densityMax.value,
  (maxValue) => {
    sampleDensity.value = clamp(sampleDensity.value, MIN_RESOLUTION_PERCENT, maxValue)
  },
  { immediate: true },
)

watch(
  () => isCompactLayout.value,
  (compact) => {
    if (!compact) {
      nextTick(() => {
        clampLayoutWidths()
      })
    }
  },
)

watch(
  () => historyCollapsed.value,
  (collapsed) => {
    if (!collapsed && !isCompactLayout.value) {
      nextTick(() => {
        clampLayoutWidths()
      })
    }
  },
)

watch(
  [themeMode, systemPrefersDark],
  () => {
    applyThemeMode(themeMode.value)
  },
  { immediate: true },
)

watch(
  componentTone,
  () => {
    applyComponentTone(componentTone.value)
  },
  { immediate: true },
)

watch(
  languageMode,
  () => {
    applyLanguageMode(languageMode.value)
  },
  { immediate: true },
)

watch(
  locale,
  () => {
    refreshStatusText()
  },
)

watch(
  [settingsOpen, settingsDraftTheme, settingsDraftTone, settingsDraftLanguage],
  ([open]) => {
    if (!open) return

    // Preview appearance changes immediately while the settings dialog is open.
    applyThemeMode(settingsDraftTheme.value)
    applyComponentTone(settingsDraftTone.value)
    applyLanguageMode(settingsDraftLanguage.value)
  },
)

const stopProgressAnimation = () => {
  if (progressAnimation) {
    progressAnimation.pause()
    progressAnimation = null
  }
}

const setPipelineProgress = (progress, options = {}) => {
  const target = clamp(progress, 0, 100)
  const smooth = Boolean(options.smooth)
  const duration = Math.max(120, Number(options.duration) || 220)

  if (!smooth) {
    stopProgressAnimation()
    pipelineProgress.value = target
    return
  }

  if (Math.abs(target - pipelineProgress.value) < 0.05) return

  stopProgressAnimation()
  const state = { value: pipelineProgress.value }

  progressAnimation = animate(state, {
    value: target,
    duration,
    ease: 'outCubic',
    onUpdate: () => {
      pipelineProgress.value = clamp(state.value, 0, 100)
    },
    onComplete: () => {
      progressAnimation = null
    },
  })
}

const stopGeneratePulse = () => {
  if (generatePulseTimer) {
    clearInterval(generatePulseTimer)
    generatePulseTimer = null
  }
}

const startGeneratePulse = () => {
  stopGeneratePulse()

  generatePulseTimer = setInterval(() => {
    if (!busy.value || !isGenerating.value) return
    if (lastGeneratePhase === 'done') return

    const cap = 96
    if (pipelineProgress.value >= cap) return

    const next = clamp(
      pipelineProgress.value + Math.max(0.12, (cap - pipelineProgress.value) * 0.038),
      0,
      cap,
    )

    pipelineProgress.value = next
    lastGenerateProgress = Math.max(lastGenerateProgress, next)
  }, 120)
}

const setStatus = (message, stage, progress, options = {}) => {
  if (message !== undefined) {
    statusMessageSpec.value = message
    statusText.value = resolveTextSpec(statusMessageSpec.value)
  }

  if (stage !== undefined) {
    statusStageSpec.value = stage
    stageText.value = resolveTextSpec(statusStageSpec.value)
  }

  if (typeof progress === 'number') {
    setPipelineProgress(progress, {
      smooth: Boolean(options.smoothProgress),
      duration: options.duration,
    })
  }
}

const setStageStatus = (stage) => {
  statusStageSpec.value = stage
  stageText.value = resolveTextSpec(statusStageSpec.value)
}

const stopTimeline = () => {
  if (timelineAnimation) {
    timelineAnimation.pause()
    timelineAnimation = null
  }

  isPlaying.value = false
}

const toDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error(t('workflow.readFileFailed', { name: file.name })))
    reader.readAsDataURL(file)
  })

const handleSourceFile = async (file) => {
  setStatus(i18nText('workflow.loadingSource', { name: file.name }), i18nText('workflow.readingImage'))

  try {
    const url = await toDataUrl(file)
    sourceImage.value = {
      name: file.name,
      url,
    }

    activeHistoryId.value = ''

    setStatus(i18nText('workflow.sourceLoaded', { name: file.name }), i18nText('workflow.standby'))
  } catch (error) {
    setStatus(error.message || i18nText('workflow.loadSourceFailed'), i18nText('workflow.error'))
  }
}

const handleTargetFile = async (file) => {
  setStatus(i18nText('workflow.loadingTarget', { name: file.name }), i18nText('workflow.readingImage'))

  try {
    const url = await toDataUrl(file)
    targetImage.value = {
      name: file.name,
      url,
    }

    activeHistoryId.value = ''

    setStatus(i18nText('workflow.targetLoaded', { name: file.name }), i18nText('workflow.standby'))
  } catch (error) {
    setStatus(error.message || i18nText('workflow.loadTargetFailed'), i18nText('workflow.error'))
  }
}

const applySelectedTemplate = () => {
  const template = builtInTemplates.find((item) => item.id === selectedTemplateId.value)
  if (!template) return

  targetImage.value = {
    name: template.name,
    url: template.src,
  }

  activeHistoryId.value = ''

  setStatus(i18nText('workflow.templateApplied', { name: template.name }), i18nText('workflow.standby'))
}

const detailToMorphOptions = (density) => {
  const maxDensity = Math.max(MIN_RESOLUTION_PERCENT, densityMax.value)
  const d = clamp(Number(density) || 8, MIN_RESOLUTION_PERCENT, maxDensity)
  const range = Math.max(0.0001, maxDensity - MIN_RESOLUTION_PERCENT)
  const ratio = clamp((d - MIN_RESOLUTION_PERCENT) / range, 0, 1)

  return {
    resolutionReferenceWidth: targetResolutionBase.value.width,
    resolutionReferenceHeight: targetResolutionBase.value.height,
    resolutionPercent: d,
    maxResolutionPercent: maxDensity,
    simulationFrames: clamp(Math.round(88 + ratio * 56), 88, 144),
    proximityFactor: 10.2 - ratio * 2.4,
  }
}

const withHistoryUiState = (item) => ({
  ...item,
  isDeleting: false,
  isExiting: false,
})

const stripHistoryUiState = (item) => {
  const { isDeleting, isExiting, ...record } = item
  return record
}

const patchHistoryItem = (id, patch) => {
  historyItems.value = historyItems.value.map((item) =>
    item.id === id
      ? {
          ...item,
          ...patch,
        }
      : item,
  )
}

const flushUiFrame = async () => {
  await nextTick()

  await new Promise((resolve) => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve())
      return
    }

    setTimeout(resolve, 0)
  })
}

const mapGenerateProgress = (rawProgress) => {
  return clamp((Number(rawProgress) || 0) * 100, 0, 100)
}

const addToHistory = async (newMorphData) => {
  const record = {
    id: uid(),
    createdAt: Date.now(),
    sourceName: sourceImage.value.name || t('imagePair.sourceTitle'),
    sourceUrl: sourceImage.value.url,
    targetName: targetImage.value.name || t('imagePair.targetTitle'),
    targetUrl: targetImage.value.url,
    pointCount: newMorphData.meta.pointCount,
    rendererMode: rendererMode.value,
    durationSeconds: durationSeconds.value,
    sampleDensity: sampleDensity.value,
    keyframes: normalizeKeyframes(keyframes.value),
    exportSettings: { ...exportSettings.value },
    morphData: newMorphData,
    thumbnail: newMorphData.sourceRasterUrl || renderMorphThumbnail(newMorphData, 0.52, {
      rendererMode: rendererMode.value,
    }),
  }

  const entry = withHistoryUiState(record)

  historyItems.value = [entry, ...historyItems.value].slice(0, 24)
  activeHistoryId.value = entry.id

  try {
    await saveHistoryRecord(stripHistoryUiState(entry))
    await pruneHistory(24)
  } catch {
    setStatus(i18nText('workflow.historyPersistWarn'), i18nText('workflow.warning'))
  }
}

const stopGenerateMorph = () => {
  if (!isGenerating.value || !generateAbortController) return

  generateAbortController.abort()
  stopGeneratePulse()
  setStatus(i18nText('workflow.generateStoppedNoSave'), i18nText('workflow.stopped'), 0, {
    smoothProgress: true,
    duration: 140,
  })
}

const stopExportMorph = () => {
  if (!exportAbortController) return

  exportAbortController.abort()
  setStatus(i18nText('workflow.exportStopping'), i18nText('workflow.stopping'), pipelineProgress.value, {
    smoothProgress: true,
    duration: 140,
  })
}

const stopBusyTask = () => {
  if (isGenerating.value) {
    stopGenerateMorph()
    return
  }

  if (exportingId.value) {
    stopExportMorph()
  }
}

const generateMorph = async () => {
  if (busy.value) return

  if (!sourceImage.value.url || !targetImage.value.url) {
    setStatus(i18nText('workflow.needPair'), i18nText('workflow.standby'))
    return
  }

  const abortController = new AbortController()
  generateAbortController = abortController
  busy.value = true
  isGenerating.value = true
  lastGenerateProgress = 0
  lastGeneratePhase = ''
  setPipelineProgress(0)
  startGeneratePulse()
  stopTimeline()
  timelineTime.value = 0
  syncMorphProgress()

  try {
    setStatus(i18nText('workflow.processingStart'), i18nText('statusBar.processing'), 0, {
      smoothProgress: true,
      duration: 160,
    })

    const morphOptions = detailToMorphOptions(sampleDensity.value)

    const nextMorphData = await buildMorphData(sourceImage.value.url, targetImage.value.url, {
      ...morphOptions,
      signal: abortController.signal,
      onProgress: (phase, p) => {
        const phaseTextMap = {
          loading: t('workflow.phase.loading'),
          rasterizing_a: t('workflow.phase.rasterizingA'),
          rasterizing_b: t('workflow.phase.rasterizingB'),
          matching_worker: t('workflow.phase.matchingWorker'),
          cell_sampling_a: t('workflow.phase.cellSamplingA'),
          cell_sampling_b: t('workflow.phase.cellSamplingB'),
          assignment: t('workflow.phase.assignment'),
          simulation: t('workflow.phase.simulation'),
          done: t('workflow.phase.done'),
        }

        const phaseLabel = phaseTextMap[phase] || phase
        const nextProgress = mapGenerateProgress(p)

        if (phase !== lastGeneratePhase) {
          lastGeneratePhase = phase
          lastGenerateProgress = 0
          setPipelineProgress(0)
        }

        setStatus(
          t('workflow.processingPrefix', { phase: phaseLabel }),
          phaseLabel,
          Math.max(lastGenerateProgress, nextProgress),
          {
            smoothProgress: true,
            duration: 180,
          },
        )

        lastGenerateProgress = Math.max(lastGenerateProgress, nextProgress)
      },
    })

    if (abortController.signal.aborted) {
      throw createAbortError(t('workflow.generateStoppedNoSave'))
    }

    morphData.value = nextMorphData
    await addToHistory(nextMorphData)

    setStatus(
      i18nText('workflow.generateSuccess', {
        count: nextMorphData.meta.cellCount,
        percent: nextMorphData.meta.resolutionPercent.toFixed(1),
      }),
      i18nText('workflow.ready'),
      100,
      {
        smoothProgress: true,
        duration: 220,
      },
    )

    await nextTick()
    playMorph(true, true)
  } catch (error) {
    if (error?.name === 'AbortError') {
      setStatus(i18nText('workflow.generateStoppedNoSave'), i18nText('workflow.stopped'), 0, {
        smoothProgress: true,
        duration: 140,
      })
    } else {
      setStatus(
        i18nText('workflow.generateFailed', {
          message: resolveErrorMessage(error),
        }),
        i18nText('workflow.error'),
        0,
      )
    }
  } finally {
    stopGeneratePulse()
    lastGeneratePhase = ''
    if (generateAbortController === abortController) {
      generateAbortController = null
    }
    isGenerating.value = false
    busy.value = false
  }
}

const playMorph = (restart = false, ignoreBusy = false) => {
  if (!morphData.value || (busy.value && !ignoreBusy)) return

  stopTimeline()

  if (restart || timelineTime.value >= 0.999) {
    timelineTime.value = 0
    syncMorphProgress()
  }

  const state = { value: timelineTime.value }
  const remaining = Math.max(0.001, 1 - state.value)

  setStatus(i18nText('workflow.playingTimeline'), i18nText('workflow.playing'), timelineTime.value * 100)
  isPlaying.value = true

  timelineAnimation = animate(state, {
    value: 1,
    duration: Math.max(120, durationSeconds.value * 1000 * remaining),
    ease: 'linear',
    onUpdate: () => {
      timelineTime.value = clamp(state.value, 0, 1)
      pipelineProgress.value = timelineTime.value * 100
    },
    onComplete: () => {
      timelineAnimation = null
      timelineTime.value = 1
      syncMorphProgress()
      pipelineProgress.value = 100
      isPlaying.value = false
      setStatus(i18nText('workflow.playbackDone'), i18nText('workflow.completed'), 100)
    },
  })
}

const pauseMorph = () => {
  stopTimeline()
  setStatus(i18nText('workflow.paused'), i18nText('workflow.pause'), timelineTime.value * 100)
}

const stopMorph = () => {
  stopTimeline()
  timelineTime.value = 0
  pipelineProgress.value = 0
  syncMorphProgress()
  setStatus(i18nText('workflow.stoppedToStart'), i18nText('workflow.stop'), 0)
}

const clearWorkspace = (message = i18nText('workflow.workspaceCleared')) => {
  stopTimeline()
  sourceImage.value = { name: '', url: '' }
  targetImage.value = { name: '', url: '' }
  morphData.value = null
  timelineTime.value = 0
  pipelineProgress.value = 0
  syncMorphProgress()
  setStatus(message, i18nText('workflow.standby'), 0)
}

const onTimelineTimeChange = (value) => {
  if (!morphData.value) return

  stopTimeline()
  timelineTime.value = clamp(value, 0, 1)
  pipelineProgress.value = timelineTime.value * 100
  setStageStatus(i18nText('workflow.manualPosition'))
}

const onKeyframesUpdate = (frames) => {
  keyframes.value = normalizeKeyframes(frames)
}

const onExportSettingsUpdate = (settings) => {
  exportSettings.value = {
    ...exportSettings.value,
    ...settings,
  }
}

const exportFromPreviewPanel = () => {
  if (!canExportActive.value) {
    setStatus(i18nText('workflow.selectExportHistory'), i18nText('workflow.standby'), pipelineProgress.value)
    return
  }

  exportHistoryItem(activeHistoryId.value)
}

const replayHistoryItem = (id) => {
  const entry = historyItems.value.find((item) => item.id === id)
  if (!entry || entry.isDeleting || entry.isExiting) return

  stopTimeline()
  activeHistoryId.value = id

  sourceImage.value = {
    name: entry.sourceName,
    url: entry.sourceUrl,
  }

  targetImage.value = {
    name: entry.targetName,
    url: entry.targetUrl,
  }

  morphData.value = entry.morphData
  sampleDensity.value = Math.max(
    MIN_RESOLUTION_PERCENT,
    Number(entry.sampleDensity ?? entry.morphData?.meta?.resolutionPercent ?? sampleDensity.value) || sampleDensity.value,
  )
  rendererMode.value = normalizeRendererMode(entry.rendererMode || rendererMode.value)
  durationSeconds.value = clamp(Number(entry.durationSeconds) || 4, 1, 12)
  keyframes.value = normalizeKeyframes(entry.keyframes || makeDefaultKeyframes())

  if (entry.exportSettings) {
    exportSettings.value = {
      ...exportSettings.value,
      ...entry.exportSettings,
    }
  }

  timelineTime.value = 0
  syncMorphProgress()

  setStatus(
    i18nText('workflow.historyLoaded', {
      source: entry.sourceName,
      target: entry.targetName,
    }),
    i18nText('workflow.historyReplay'),
    0,
  )
}

const removeHistoryItem = async (id) => {
  const entry = historyItems.value.find((item) => item.id === id)
  if (!entry || entry.isDeleting || entry.isExiting) return

  if (busy.value) {
    setStatus(i18nText('workflow.busyTask'), i18nText('workflow.busy'), pipelineProgress.value)
    return
  }

  const wasActive = activeHistoryId.value === id

  if (wasActive) {
    activeHistoryId.value = ''
  }

  patchHistoryItem(id, { isDeleting: true })

  try {
    await flushUiFrame()
    await deleteHistoryRecord(id)
    patchHistoryItem(id, { isDeleting: false, isExiting: true })

    const timer = setTimeout(() => {
      historyItems.value = historyItems.value.filter((item) => item.id !== id)
      historyRemoveTimers.delete(id)
    }, HISTORY_REMOVE_EXIT_DURATION)

    historyRemoveTimers.set(id, timer)
  } catch {
    patchHistoryItem(id, { isDeleting: false, isExiting: false })

    if (wasActive && !activeHistoryId.value) {
      activeHistoryId.value = id
    }

    setStatus(i18nText('workflow.deleteHistoryFailed'), i18nText('workflow.warning'))
  }
}

const resolveExportSize = (data, preset) => {
  const even = (value) => Math.max(2, Math.round(value / 2) * 2)

  if (!data || !preset || preset === 'native') {
    return {
      width: even(data?.width || 460),
      height: even(data?.height || 460),
    }
  }

  const longEdge =
    {
      '720p': 1280,
      '1080p': 1920,
      '1440p': 2560,
    }[preset] || 1280

  const w = data.width
  const h = data.height

  if (w >= h) {
    return {
      width: even(longEdge),
      height: even((longEdge * h) / w),
    }
  }

  return {
    width: even((longEdge * w) / h),
    height: even(longEdge),
  }
}

const mapExportProgress = (phase, progress) => {
  if (phase === 'recording_webgl_setup') return 2 + progress * 8
  if (phase === 'recording_webgl_fallback') return 10
  if (phase === 'recording') return 10 + progress * 45
  if (phase === 'encoding') return 55 + progress * 44
  return 100
}

const exportHistoryItem = async (id) => {
  const entry = historyItems.value.find((item) => item.id === id)
  if (!entry || entry.isDeleting || entry.isExiting) return

  if (busy.value) {
    setStatus(i18nText('workflow.busyTask'), i18nText('workflow.busy'), pipelineProgress.value)
    return
  }

  const abortController = new AbortController()
  exportAbortController = abortController

  busy.value = true
  exportingId.value = id
  stopTimeline()

  try {
    const fps = clamp(Number(exportSettings.value.fps) || 24, 8, 48)
    const { width, height } = resolveExportSize(entry.morphData, exportSettings.value.resolution)

    setStatus(
      i18nText('workflow.preparingExport', { width, height, fps }),
      i18nText('workflow.exporting'),
      4,
    )

    const gifBlob = await exportMorphAsGif(entry.morphData, {
      durationSeconds: entry.durationSeconds,
      fps,
      width,
      height,
      rendererMode: normalizeRendererMode(rendererMode.value),
      keyframes: normalizeKeyframes(entry.keyframes || keyframes.value),
      renderBackend: 'webgl',
      allow2DFallback: true,
      signal: abortController.signal,
      onProgress: (phase, p) => {
        const phaseLabel = {
          recording_webgl_setup: i18nText('workflow.exportPhase.setupWebGL'),
          recording_webgl_fallback: i18nText('workflow.exportPhase.fallback2d'),
          recording: i18nText('workflow.exportPhase.recording'),
          encoding: i18nText('workflow.exportPhase.encoding'),
          done: i18nText('workflow.exportPhase.done'),
        }[phase]

        setStatus(
          i18nText('workflow.exportPhasePrefix', { phase: phaseLabel || phase }),
          i18nText('workflow.exporting'),
          mapExportProgress(phase, p),
        )
      },
    })

    if (abortController.signal.aborted) {
      throw createAbortError(t('workflow.exportStoppedNoSave'))
    }

    const filename = buildDefaultGifFilename()
    downloadBlob(gifBlob, filename)

    setStatus(i18nText('workflow.exportSuccess', { filename }), i18nText('workflow.completed'), 100)
  } catch (error) {
    if (error?.name === 'AbortError') {
      setStatus(i18nText('workflow.exportStoppedNoSave'), i18nText('workflow.stopped'), 0, {
        smoothProgress: true,
        duration: 140,
      })
    } else {
      setStatus(
        i18nText('workflow.exportFailed', {
          message: resolveErrorMessage(error),
        }),
        i18nText('workflow.error'),
        0,
      )
    }
  } finally {
    if (exportAbortController === abortController) {
      exportAbortController = null
    }
    busy.value = false
    exportingId.value = ''
  }
}

const savePrefsSoon = () => {
  if (prefsTimer) clearTimeout(prefsTimer)

  prefsTimer = setTimeout(() => {
    saveUiPrefs({
      selectedTemplateId: selectedTemplateId.value,
      themeMode: themeMode.value,
      componentTone: componentTone.value,
      languageMode: languageMode.value,
      rendererMode: rendererMode.value,
      sampleDensity: sampleDensity.value,
      durationSeconds: durationSeconds.value,
      keyframes: keyframes.value,
      exportSettings: exportSettings.value,
      historyCollapsed: historyCollapsed.value,
      layoutSizes: {
        historyPanelWidth: Math.round(historyPanelWidth.value),
        imagePanelWidth: Math.round(imagePanelWidth.value),
      },
    })
  }, 180)
}

watch(
  [
    selectedTemplateId,
    themeMode,
    componentTone,
    languageMode,
    rendererMode,
    sampleDensity,
    durationSeconds,
    keyframes,
    exportSettings,
    historyCollapsed,
    historyPanelWidth,
    imagePanelWidth,
  ],
  () => {
    savePrefsSoon()
  },
  { deep: true },
)

onMounted(async () => {
  isLoadingHistory.value = true
  const prefs = loadUiPrefs()

  if (prefs) {
    selectedTemplateId.value = prefs.selectedTemplateId || selectedTemplateId.value
    themeMode.value = normalizeThemeMode(prefs.themeMode || themeMode.value)
    componentTone.value = normalizeComponentTone(prefs.componentTone || componentTone.value)
    languageMode.value = normalizeLanguageMode(prefs.languageMode || languageMode.value)
    rendererMode.value = normalizeRendererMode(prefs.rendererMode || rendererMode.value)
    sampleDensity.value = Math.max(
      MIN_RESOLUTION_PERCENT,
      Number(prefs.sampleDensity) || sampleDensity.value,
    )
    durationSeconds.value = clamp(Number(prefs.durationSeconds) || durationSeconds.value, 1, 12)
    historyCollapsed.value = Boolean(prefs.historyCollapsed)

    if (Array.isArray(prefs.keyframes)) {
      keyframes.value = normalizeKeyframes(prefs.keyframes)
    }

    if (prefs.exportSettings) {
      exportSettings.value = {
        ...exportSettings.value,
        ...prefs.exportSettings,
      }
    }

    if (prefs.layoutSizes) {
      const storedHistoryWidth = Number(prefs.layoutSizes.historyPanelWidth)
      const migratedHistoryWidth = [248, 260].includes(Math.round(storedHistoryWidth))
        ? historyPanelWidth.value
        : storedHistoryWidth

      historyPanelWidth.value = clamp(
        migratedHistoryWidth || historyPanelWidth.value,
        HISTORY_PANEL_MIN,
        HISTORY_PANEL_MAX,
      )
      imagePanelWidth.value = clamp(
        Number(prefs.layoutSizes.imagePanelWidth) || imagePanelWidth.value,
        IMAGE_PANEL_MIN,
        IMAGE_PANEL_MAX,
      )
    }
  }

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)')
    systemPrefersDark.value = Boolean(systemThemeMedia.matches)

    if (typeof systemThemeMedia.addEventListener === 'function') {
      systemThemeMedia.addEventListener('change', onSystemThemeChange)
    } else if (typeof systemThemeMedia.addListener === 'function') {
      systemThemeMedia.addListener(onSystemThemeChange)
    }
  }

  applyThemeMode(themeMode.value)
  applyComponentTone(componentTone.value)
  applyLanguageMode(languageMode.value)
  setStatus(i18nText('workflow.standby'), i18nText('workflow.standby'), 0)

  window.addEventListener('resize', onViewportResize)

  try {
    const loaded = await loadHistoryRecords(24)

    historyItems.value = loaded.map((item) => withHistoryUiState({
      ...item,
      rendererMode: normalizeRendererMode(item.rendererMode || rendererMode.value),
      sampleDensity: Math.max(
        MIN_RESOLUTION_PERCENT,
        Number(item.sampleDensity ?? item.morphData?.meta?.resolutionPercent ?? sampleDensity.value) || sampleDensity.value,
      ),
      keyframes: normalizeKeyframes(item.keyframes || makeDefaultKeyframes()),
      exportSettings: {
        ...exportSettings.value,
        ...(item.exportSettings || {}),
      },
    }))

    if (historyItems.value.length > 0) {
      replayHistoryItem(historyItems.value[0].id)
    }
  } catch {
    setStatus(i18nText('workflow.historyLoadFailed'), i18nText('workflow.warning'))
  } finally {
    isLoadingHistory.value = false
  }

  syncMorphProgress()

  await nextTick()
  if (!isCompactLayout.value) {
    clampLayoutWidths()
  }
})

onBeforeUnmount(() => {
  cancelCacheStatsRefresh()
  generateAbortController?.abort()
  exportAbortController?.abort()
  stopTimeline()
  stopProgressAnimation()
  stopGeneratePulse()
  stopPaneResize()
  window.removeEventListener('resize', onViewportResize)

  if (systemThemeMedia) {
    if (typeof systemThemeMedia.removeEventListener === 'function') {
      systemThemeMedia.removeEventListener('change', onSystemThemeChange)
    } else if (typeof systemThemeMedia.removeListener === 'function') {
      systemThemeMedia.removeListener(onSystemThemeChange)
    }

    systemThemeMedia = null
  }

  if (prefsTimer) {
    clearTimeout(prefsTimer)
    prefsTimer = null
  }

  for (const timer of historyRemoveTimers.values()) {
    clearTimeout(timer)
  }
  historyRemoveTimers.clear()

  clearSettingsAnimationTimers()
})
</script>

<template>
  <div class="app-shell">
    <div ref="mainLayoutRef" class="main-layout" :style="mainLayoutStyle">
      <HistoryPanel
        :collapsed="historyCollapsed"
        :loading="isLoadingHistory"
        :items="historyItems"
        :active-id="activeHistoryId"
        :exporting-id="exportingId"
        @toggle="historyCollapsed = !historyCollapsed"
        @replay="replayHistoryItem"
        @export="exportHistoryItem"
        @remove="removeHistoryItem"
        @open-settings="openSettings"
      />

      <div
        v-if="!isCompactLayout"
        class="layout-splitter history-splitter"
        :class="{ 'is-collapsed': historyCollapsed }"
        role="separator"
        :aria-hidden="historyCollapsed ? 'true' : null"
        aria-orientation="vertical"
        :aria-label="t('app.splitters.historyMain')"
        @pointerdown="!historyCollapsed && startPaneResize('history', $event)"
      />

      <main
        ref="centerLayoutRef"
        class="center-layout"
        :class="{ 'history-collapsed': historyCollapsed && !isCompactLayout }"
        :style="centerLayoutStyle"
      >
        <ImagePairPanel
          class="image-column"
          :source-url="sourceImage.url"
          :source-name="sourceImage.name"
          :target-url="targetImage.url"
          :target-name="targetImage.name"
          :templates="builtInTemplates"
          :selected-template-id="selectedTemplateId"
          :busy="busy"
          @source-file="handleSourceFile"
          @target-file="handleTargetFile"
          @template-change="selectedTemplateId = $event"
          @apply-template="applySelectedTemplate"
        />

        <div
          v-if="!isCompactLayout"
          class="layout-splitter center-splitter"
          role="separator"
          aria-orientation="vertical"
          :aria-label="t('app.splitters.imagePreview')"
          @pointerdown="startPaneResize('image', $event)"
        />

        <AnimationPanel
          class="animation-column"
          :morph-data="morphData"
          :renderer-mode="rendererMode"
          :timeline-time="timelineTime"
          :morph-progress="morphProgress"
          :is-playing="isPlaying"
          :is-generating="isGenerating"
          :is-loading-data="isLoadingHistory"
          :loading-progress="pipelineProgress"
          :loading-text="isGenerating ? statusText : t('app.loadingHistory')"
          :duration-seconds="durationSeconds"
          :keyframes="keyframes"
          :export-settings="exportSettings"
          :busy="busy"
          :can-export="canExportActive"
          :is-exporting="isExportingActive"
          @play="playMorph"
          @pause="pauseMorph"
          @stop="stopMorph"
          @export="exportFromPreviewPanel"
          @update:timelineTime="onTimelineTimeChange"
          @update:durationSeconds="durationSeconds = clamp($event, 1, 12)"
          @update:keyframes="onKeyframesUpdate"
          @update:exportSettings="onExportSettingsUpdate"
        />
      </main>
    </div>

    <StatusBar
      :status-text="statusText"
      :stage-text="stageText"
      :position-text="positionText"
      :progress="pipelineProgress"
      :density="sampleDensity"
      :density-max="densityMax"
      :effective-resolution="effectiveResolution"
      :busy="busy"
      :can-stop-generate="canStopProcessing"
      :stop-label="stopActionLabel"
      :can-generate="hasReadyPair"
      @generate="generateMorph"
      @stop-generate="stopBusyTask"
      @update:density="sampleDensity = clamp($event, MIN_RESOLUTION_PERCENT, densityMax)"
    />

    <div v-if="settingsOpen" class="settings-overlay" :class="{ 'is-visible': settingsDialogVisible }" @click.self="cancelSettings">
      <section
        class="settings-dialog"
        :class="{ 'is-visible': settingsDialogVisible }"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div class="settings-content-shell" :class="{ 'is-visible': settingsContentVisible }">
          <button
            type="button"
            class="settings-close"
            :aria-label="t('settings.close')"
            :title="t('settings.close')"
            @click="cancelSettings"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6L18 18" />
              <path d="M18 6L6 18" />
            </svg>
          </button>

          <header class="settings-header">
            <h2 id="settings-title">{{ t('settings.title') }}</h2>
          </header>

          <div class="settings-body">
            <aside class="settings-tabs" :aria-label="t('settings.tabsAria')">
              <button
                type="button"
                class="settings-tab"
                :class="{ active: settingsActiveTab === 'appearance' }"
                :aria-current="settingsActiveTab === 'appearance' ? 'page' : null"
                @click="settingsActiveTab = 'appearance'"
              >
                {{ t('settings.tabs.appearance') }}
              </button>
              <button
                type="button"
                class="settings-tab"
                :class="{ active: settingsActiveTab === 'cache' }"
                :aria-current="settingsActiveTab === 'cache' ? 'page' : null"
                @click="settingsActiveTab = 'cache'"
              >
                {{ t('settings.tabs.cache') }}
              </button>
              <button
                type="button"
                class="settings-tab"
                :class="{ active: settingsActiveTab === 'about' }"
                :aria-current="settingsActiveTab === 'about' ? 'page' : null"
                @click="settingsActiveTab = 'about'"
              >
                {{ t('settings.tabs.about') }}
              </button>
            </aside>

            <section class="settings-panel">
              <template v-if="settingsActiveTab === 'appearance'">
                <label class="settings-field">
                  <span>{{ t('settings.fields.theme') }}</span>
                  <select v-model="settingsDraftTheme">
                    <option v-for="mode in THEME_MODE_OPTIONS" :key="mode.value" :value="mode.value">
                      {{ resolveThemeModeDisplayLabel(mode) }}
                    </option>
                  </select>
                </label>

                <label class="settings-field">
                  <span>{{ t('settings.fields.language') }}</span>
                  <select v-model="settingsDraftLanguage">
                    <option v-for="mode in LANGUAGE_MODE_OPTIONS" :key="mode.value" :value="mode.value">
                      {{ mode.label }}
                    </option>
                  </select>
                </label>

                <label class="settings-field">
                  <span>{{ t('settings.fields.renderer') }}</span>
                  <select v-model="settingsDraftRenderer">
                    <option v-for="mode in RENDERER_MODE_OPTIONS" :key="mode" :value="mode">
                      {{ t(`settings.renderers.${mode}`) }}
                    </option>
                  </select>
                </label>

                <div class="settings-field tone-field">
                  <span>{{ t('settings.fields.componentTone') }}</span>
                  <div class="tone-options" role="radiogroup" :aria-label="t('settings.toneGroupAria')">
                    <button
                      v-for="tone in COMPONENT_TONE_OPTIONS"
                      :key="tone.value"
                      type="button"
                      class="tone-option"
                      :class="{ active: settingsDraftTone === tone.value }"
                      :aria-checked="settingsDraftTone === tone.value"
                      :aria-label="resolveToneDisplayLabel(tone)"
                      :title="resolveToneDisplayLabel(tone)"
                      role="radio"
                      @click="settingsDraftTone = tone.value"
                    >
                      <span class="tone-dot" :style="{ '--tone-dot-color': tone.dot }" />
                    </button>
                  </div>
                </div>
              </template>

              <section v-else-if="settingsActiveTab === 'cache'" class="cache-panel" aria-labelledby="cache-title">
                <h3 id="cache-title">{{ t('settings.cache.title') }}</h3>

                <div v-if="cacheStatsLoading" class="cache-loading" aria-live="polite">
                  <span class="cache-loading-label">{{ t('settings.cache.loading') }}</span>
                  <div class="cache-loading-track">
                    <span class="cache-loading-fill" />
                  </div>
                  <div class="cache-loading-lines">
                    <span v-for="line in 4" :key="line" class="cache-loading-line" />
                  </div>
                </div>

                <template v-else>
                  <div
                    class="cache-bar-wrap"
                    role="img"
                    :aria-label="t('settings.cache.barAria', { total: cacheStats.totalReadable })"
                  >
                    <div v-if="cacheStats.totalBytes > 0" :key="cacheBarAnimationKey" class="cache-bar">
                      <span
                        v-for="segment in cacheStats.segments"
                        :key="segment.key"
                        class="cache-segment"
                        :style="{
                          width: `${segment.percent}%`,
                          backgroundColor: segment.color,
                        }"
                      />
                    </div>
                    <div v-else class="cache-empty">{{ t('settings.cache.empty') }}</div>
                  </div>

                  <div class="cache-summary">
                    {{
                      t('settings.cache.total', {
                        total: cacheStats.totalReadable,
                        records: cacheStats.recordCount,
                      })
                    }}
                  </div>

                  <ul class="cache-legend">
                    <li v-for="segment in cacheStats.segments" :key="segment.key" class="cache-legend-item">
                      <span class="cache-legend-dot" :style="{ backgroundColor: segment.color }" />
                      <span class="cache-legend-name">{{ segment.label }}</span>
                      <span class="cache-legend-size">{{ segment.readable }}</span>
                    </li>
                  </ul>
                </template>

                <button
                  type="button"
                  class="cache-clear-btn"
                  :disabled="!canClearAllRecords"
                  @click="openClearRecordsConfirm"
                >
                  {{ isClearingRecords ? t('settings.cache.clearing') : t('settings.cache.clearAllRecords') }}
                </button>

                <p class="cache-clear-hint">{{ t('settings.cache.clearHint') }}</p>
              </section>

              <section v-else class="about-panel" aria-labelledby="about-title">
                <h3 id="about-title">pixmove</h3>
                <p class="about-desc">{{ t('settings.about.description') }}</p>

                <div class="settings-inline-actions">
                  <a
                    class="about-link"
                    href="https://github.com/lupnis/pixmove"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <svg class="about-btn-icon" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 2C6.48 2 2 6.58 2 12.23c0 4.52 2.87 8.35 6.84 9.71.5.1.68-.22.68-.49 0-.24-.01-1.05-.01-1.9-2.78.62-3.37-1.21-3.37-1.21-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .08 1.54 1.06 1.54 1.06.9 1.58 2.35 1.12 2.92.86.09-.67.35-1.12.63-1.38-2.22-.26-4.55-1.14-4.55-5.08 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.72 0 0 .84-.28 2.75 1.05A9.3 9.3 0 0 1 12 6.84c.85 0 1.71.12 2.52.36 1.9-1.33 2.74-1.05 2.74-1.05.55 1.42.2 2.46.1 2.72.64.72 1.03 1.63 1.03 2.75 0 3.95-2.34 4.82-4.57 5.07.36.32.67.94.67 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.59.69.49A10.28 10.28 0 0 0 22 12.23C22 6.58 17.52 2 12 2Z" />
                    </svg>
                    <span>{{ t('settings.about.githubRepo') }}</span>
                  </a>

                  <a
                    class="about-issue-btn"
                    href="https://github.com/lupnis/pixmove/issues/new/choose"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {{ t('settings.about.submitIssue') }}
                  </a>
                </div>
              </section>
            </section>
          </div>

          <footer class="settings-actions">
            <button type="button" class="settings-cancel" @click="cancelSettings">{{ t('settings.cancel') }}</button>
            <button type="button" class="settings-confirm" @click="confirmSettings">{{ t('settings.confirm') }}</button>
          </footer>
        </div>
      </section>

      <div v-if="showClearRecordsConfirm" class="danger-confirm-overlay" @click.self="closeClearRecordsConfirm">
        <section
          class="danger-confirm-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="danger-confirm-title"
        >
          <h3 id="danger-confirm-title">{{ t('settings.cache.confirm.title') }}</h3>
          <p>{{ t('settings.cache.confirm.message') }}</p>

          <div class="danger-confirm-actions">
            <button type="button" class="danger-cancel" @click="closeClearRecordsConfirm">
              {{ t('settings.cache.confirm.cancel') }}
            </button>
            <button
              type="button"
              class="danger-confirm"
              :disabled="isClearingRecords"
              @click="clearAllHistoryData"
            >
              {{ t('settings.cache.confirm.confirm') }}
            </button>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
