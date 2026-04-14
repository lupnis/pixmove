<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createPixiMorphRenderer } from '../composables/usePixiMorphRenderer'
import {
  easingOptions,
  normalizeKeyframes,
} from '../utils/timeline'
import { useI18n } from '../i18n/useI18n'

const { t } = useI18n()

const props = defineProps({
  morphData: {
    type: Object,
    default: null,
  },
  timelineTime: {
    type: Number,
    default: 0,
  },
  morphProgress: {
    type: Number,
    default: 0,
  },
  isPlaying: {
    type: Boolean,
    default: false,
  },
  isGenerating: {
    type: Boolean,
    default: false,
  },
  isLoadingData: {
    type: Boolean,
    default: false,
  },
  loadingProgress: {
    type: Number,
    default: 0,
  },
  loadingText: {
    type: String,
    default: '',
  },
  durationSeconds: {
    type: Number,
    default: 4,
  },
  keyframes: {
    type: Array,
    default: () => [],
  },
  exportSettings: {
    type: Object,
    default: () => ({
      resolution: 'native',
      fps: 24,
    }),
  },
  rendererMode: {
    type: String,
    default: 'voronoi',
  },
  sourceOverlayEnabled: {
    type: Boolean,
    default: false,
  },
  busy: {
    type: Boolean,
    default: false,
  },
  canExport: {
    type: Boolean,
    default: false,
  },
  isExporting: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits([
  'play',
  'pause',
  'stop',
  'export',
  'update:timelineTime',
  'update:durationSeconds',
  'update:keyframes',
  'update:exportSettings',
])

const pixiHostRef = ref(null)
let renderer = null

const normalizedLoadingProgress = computed(() =>
  Math.max(0, Math.min(100, Number(props.loadingProgress) || 0)),
)

const showLoadingOverlay = computed(() => props.isGenerating || props.isLoadingData)

const loadingTitle = computed(() => (props.isGenerating ? t('animation.loadingGenerating') : t('animation.loadingData')))

const loadingDesc = computed(() => {
  if (props.loadingText) return props.loadingText
  return props.isGenerating ? t('animation.loadingDescGenerating') : t('animation.loadingDescData')
})

const previewGridWidth = computed(() =>
  props.morphData?.meta?.resolutionWidth
  ?? props.morphData?.grid?.columns
  ?? props.morphData?.meta?.resolution
  ?? props.morphData?.grid?.side
  ?? 0,
)

const previewGridHeight = computed(() =>
  props.morphData?.meta?.resolutionHeight
  ?? props.morphData?.grid?.rows
  ?? props.morphData?.meta?.resolution
  ?? props.morphData?.grid?.side
  ?? 0,
)

const onScrub = (event) => {
  emit('update:timelineTime', Number(event.target.value))
}

const onDurationInput = (event) => {
  emit('update:durationSeconds', Number(event.target.value))
}

const updateKeyframes = (frames) => {
  emit('update:keyframes', normalizeKeyframes(frames))
}

const updateFrame = (id, patch) => {
  const next = props.keyframes.map((item) =>
    item.id === id
      ? {
          ...item,
          ...patch,
        }
      : item,
  )

  updateKeyframes(next)
}

const patchExportSettings = (patch) => {
  emit('update:exportSettings', {
    ...props.exportSettings,
    ...patch,
  })
}

watch(
  () => props.morphProgress,
  (value) => {
    renderer?.setProgress(value)
    renderer?.renderFrame()
  },
)

watch(
  () => props.morphData,
  async (value) => {
    if (!renderer) return

    await renderer.setMorphData(value)
    renderer.setProgress(props.morphProgress)
    renderer.renderFrame()
  },
)

watch(
  () => props.rendererMode,
  async (value) => {
    if (!renderer) return
    await renderer.setRendererMode?.(value)
    renderer.setProgress(props.morphProgress)
    renderer.renderFrame()
  },
)

watch(
  () => props.sourceOverlayEnabled,
  (value) => {
    if (!renderer) return
    renderer.setSourceOverlayEnabled?.(value)
  },
)

onMounted(async () => {
  if (!pixiHostRef.value) return

  renderer = await createPixiMorphRenderer(pixiHostRef.value, {
    rendererMode: props.rendererMode,
    sourceOverlayEnabled: props.sourceOverlayEnabled,
  })

  if (props.morphData) {
    await renderer.setMorphData(props.morphData)
  }

  renderer.setProgress(props.morphProgress)
  renderer.renderFrame()
})

onBeforeUnmount(() => {
  renderer?.destroy()
  renderer = null
})
</script>

<template>
  <section class="animation-panel">
    <header class="animation-head">
      <div>
        <strong>{{ t('animation.preview') }}</strong>
      </div>

      <div class="head-actions">
        <button
          type="button"
          class="accent icon-btn"
          :disabled="busy || !morphData || isPlaying"
          :aria-label="t('animation.play')"
          :title="t('animation.play')"
          @click="emit('play')"
        >
          <svg class="icon-play" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 5V19L19 12Z" />
          </svg>
        </button>
        <button
          type="button"
          class="icon-btn"
          :disabled="busy || !isPlaying"
          :aria-label="t('animation.pause')"
          :title="t('animation.pause')"
          @click="emit('pause')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 6V18" />
            <path d="M15 6V18" />
          </svg>
        </button>
        <button
          type="button"
          class="icon-btn"
          :disabled="busy || !morphData"
          :aria-label="t('animation.stop')"
          :title="t('animation.stop')"
          @click="emit('stop')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="7" y="7" width="10" height="10" rx="1" ry="1" />
          </svg>
        </button>
        <button
          type="button"
          class="export-btn icon-btn"
          :class="{ exporting: isExporting }"
          :disabled="busy || !canExport"
          :aria-label="isExporting ? t('animation.exporting') : t('animation.exportGif')"
          :title="isExporting ? t('animation.exporting') : t('animation.exportGif')"
          @click="emit('export')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 4V14" />
            <path d="M8 10L12 14L16 10" />
            <path d="M5 18H19" />
          </svg>
        </button>
      </div>
    </header>

    <div class="preview-wrap">
      <div ref="pixiHostRef" class="pixi-host" />

      <div v-if="showLoadingOverlay" class="loading-overlay">
        <div class="loading-card">
          <strong>{{ loadingTitle }}</strong>
          <span>{{ loadingDesc }}</span>

          <div class="loading-track">
            <div
              class="loading-fill"
              :class="{ indeterminate: !isGenerating }"
              :style="isGenerating ? { width: `${normalizedLoadingProgress}%` } : null"
            />
          </div>

          <small v-if="isGenerating">{{ Math.round(normalizedLoadingProgress) }}%</small>
        </div>
      </div>

      <div v-else-if="!morphData" class="overlay-tip">{{ t('animation.waiting') }}</div>
    </div>

    <div class="control-box">
      <div v-if="morphData" class="preview-stats">
        <span>{{ morphData.meta.resolutionPercent.toFixed(1) }}% {{ t('animation.ofTarget') }}</span>
        <span>{{ previewGridWidth }} x {{ previewGridHeight }} {{ t('animation.cellsUnit') }}</span>
        <span>{{ morphData.meta.generationCount }} {{ t('animation.swapRounds') }}</span>
        <span>{{ morphData.meta.acceptedSwaps }} {{ t('animation.acceptedSwaps') }}</span>
      </div>

      <div class="timeline-meta">
        <label>
          {{ t('animation.duration') }}
          <input
            type="range"
            min="1"
            max="12"
            step="0.5"
            :disabled="busy"
            :value="durationSeconds"
            @input="onDurationInput"
          />
          <span>{{ durationSeconds.toFixed(1) }}s</span>
        </label>
      </div>

      <div class="scrubber">
        <input
          type="range"
          min="0"
          max="1"
          step="0.001"
          :disabled="busy || !morphData"
          :value="timelineTime"
          @input="onScrub"
        />

        <div class="ticks">
          <span>{{ t('animation.timelineStart') }}</span>
          <span>{{ t('animation.morph', { value: Math.round(morphProgress * 100) }) }}</span>
          <span>{{ t('animation.timelineEnd') }}</span>
        </div>
      </div>

      <div class="keyframe-editor">
        <article v-for="(frame, index) in keyframes" :key="frame.id" class="kf-row">
          <strong>K{{ index + 1 }}</strong>

          <label>
            T
            <input
              type="range"
              min="0"
              max="1"
              step="0.001"
              :disabled="busy || frame.locked"
              :value="frame.time"
              @input="updateFrame(frame.id, { time: Number($event.target.value) })"
            />
            <span>{{ frame.time.toFixed(3) }}</span>
          </label>

          <label>
            V
            <input
              type="range"
              min="0"
              max="1"
              step="0.001"
              :disabled="busy || frame.locked"
              :value="frame.value"
              @input="updateFrame(frame.id, { value: Number($event.target.value) })"
            />
            <span>{{ frame.value.toFixed(3) }}</span>
          </label>

          <label class="ease-cell">
            E
            <select
              v-if="index < keyframes.length - 1"
              :disabled="busy"
              :value="frame.easeToNext"
              @change="updateFrame(frame.id, { easeToNext: $event.target.value })"
            >
              <option v-for="item in easingOptions" :key="item" :value="item">{{ item }}</option>
            </select>
            <span v-else class="ease-placeholder-control">{{ t('animation.keyframeEnd') }}</span>
          </label>
        </article>
      </div>

      <div class="export-editor">
        <strong>{{ t('animation.exportTitle') }}</strong>

        <label>
          {{ t('animation.resolution') }}
          <select
            :disabled="busy"
            :value="exportSettings.resolution"
            @change="patchExportSettings({ resolution: $event.target.value })"
          >
            <option value="native">{{ t('animation.nativeResolution') }}</option>
            <option value="720p">{{ t('animation.r720p') }}</option>
            <option value="1080p">{{ t('animation.r1080p') }}</option>
            <option value="1440p">{{ t('animation.r1440p') }}</option>
          </select>
        </label>

        <label>
          {{ t('animation.fps') }}
          <input
            type="number"
            min="8"
            max="48"
            step="1"
            :disabled="busy"
            :value="exportSettings.fps"
            @input="patchExportSettings({ fps: Number($event.target.value) || 24 })"
          />
        </label>
      </div>
    </div>
  </section>
</template>

<style scoped>
.animation-panel {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  border: 1px solid var(--line-strong);
  border-radius: 16px;
  overflow: hidden;
  background: var(--bg-panel);
}

.animation-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line-soft);
}

.animation-head strong {
  color: var(--text-main);
  font-size: 16px;
}

.animation-head span {
  display: block;
  font-size: 12px;
  color: var(--text-muted);
}

.head-actions {
  display: flex;
  gap: 8px;
}

.head-actions button,
.keyframe-editor select,
.export-editor select,
.export-editor input {
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  padding: 6px 11px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-main);
  font-size: 12px;
}

.head-actions .accent {
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: var(--text-main);
  font-weight: 700;
}

.head-actions .icon-btn {
  width: 32px;
  height: 32px;
  padding: 0;
  display: grid;
  place-items: center;
}

.head-actions .icon-btn svg {
  width: 16px;
  height: 16px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.head-actions .icon-btn .icon-play {
  fill: currentColor;
  stroke: none;
}

.head-actions .export-btn {
  border-color: var(--accent-border);
  background: var(--accent-soft);
}

.head-actions .export-btn.exporting svg {
  animation: export-icon-pulse 1s ease-in-out infinite;
}

@keyframes export-icon-pulse {
  0%,
  100% {
    transform: translateY(0);
    opacity: 0.82;
  }

  50% {
    transform: translateY(1px);
    opacity: 1;
  }
}

.preview-wrap {
  min-height: 160px;
  position: relative;
  overflow: hidden;
  background: radial-gradient(circle at 75% 15%, rgba(237, 167, 104, 0.16), transparent 40%),
    radial-gradient(circle at 15% 80%, rgba(91, 219, 181, 0.12), transparent 44%),
    var(--bg-card);
}

.pixi-host {
  width: 100%;
  height: 100%;
  overflow: hidden;
  isolation: isolate;
}

.pixi-host :deep(canvas) {
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  display: block;
}

.overlay-tip {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: rgba(232, 242, 255, 0.75);
  font-size: 14px;
  pointer-events: none;
}

.loading-overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
}

.loading-card {
  width: min(82%, 360px);
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  padding: 10px 12px;
  display: grid;
  gap: 8px;
  background: color-mix(in srgb, var(--bg-panel) 92%, transparent);
  backdrop-filter: blur(2px);
}

.loading-card strong {
  color: var(--text-main);
  font-size: 13px;
}

.loading-card span {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.35;
}

.loading-track {
  height: 8px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.04);
}

.loading-fill {
  height: 100%;
  width: 0;
  background: linear-gradient(90deg, var(--accent), var(--accent-strong));
  transition: width 160ms ease;
}

.loading-fill.indeterminate {
  width: 35%;
  animation: loading-indeterminate 1.15s ease-in-out infinite;
}

.loading-card small {
  color: var(--text-main);
  font-size: 11px;
  justify-self: end;
}

@keyframes loading-indeterminate {
  0% {
    transform: translateX(-120%);
  }

  100% {
    transform: translateX(360%);
  }
}

.control-box {
  position: relative;
  z-index: 1;
  border-top: 1px solid var(--line-soft);
  padding: 8px 10px;
  display: grid;
  gap: 8px;
  max-height: none;
  overflow: visible;
  background: var(--bg-panel-soft);
}

.preview-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.preview-stats span {
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--text-muted);
}

.timeline-meta {
  display: grid;
  grid-template-columns: minmax(220px, 1fr);
  gap: 10px;
  align-items: center;
  margin-bottom: 6px;
}

.timeline-meta label {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: 12px;
}

.timeline-meta span {
  color: var(--text-main);
  font-weight: 600;
  min-width: 46px;
  text-align: right;
}

.scrubber {
  display: grid;
  gap: 5px;
  margin-top: 4px;
}

.scrubber input {
  width: 100%;
}

.ticks {
  display: flex;
  justify-content: space-between;
  color: var(--text-muted);
  font-size: 11px;
}

.keyframe-editor {
  display: grid;
  gap: 8px;
}

.kf-row {
  display: grid;
  grid-template-columns: 44px minmax(150px, 1fr) minmax(150px, 1fr) auto;
  gap: 6px;
  align-items: center;
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  padding: 7px;
  min-height: 46px;
}

.kf-row strong {
  color: var(--text-main);
  font-size: 12px;
}

.kf-row label {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 11px;
}

.kf-row span {
  font-size: 11px;
  color: var(--text-main);
  min-width: 40px;
  text-align: right;
}

.ease-cell {
  min-width: 0;
}

.ease-placeholder-control {
  min-height: 30px;
  border: 1px dashed var(--line-soft);
  border-radius: 9px;
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  background: rgba(255, 255, 255, 0.03);
}

.export-editor {
  display: grid;
  grid-template-columns: auto repeat(2, minmax(140px, auto));
  gap: 10px;
  align-items: center;
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  padding: 8px;
}

.export-editor strong {
  color: var(--text-main);
  font-size: 12px;
}

.export-editor label {
  display: grid;
  grid-template-columns: auto auto;
  gap: 8px;
  align-items: center;
  color: var(--text-muted);
  font-size: 12px;
}

@media (max-width: 980px) {
  .animation-panel {
    grid-template-rows: auto minmax(0, 1fr) auto;
  }

  .preview-wrap {
    min-height: 200px;
  }

  .timeline-meta {
    grid-template-columns: 1fr;
  }

  .kf-row {
    grid-template-columns: 40px 1fr;
  }

  .export-editor {
    grid-template-columns: 1fr;
  }
}

@media (max-height: 860px) {
  .preview-wrap {
    min-height: 130px;
  }
}
</style>
