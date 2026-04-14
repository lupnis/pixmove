<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { formatTimestamp } from '../utils/format'
import { useI18n } from '../i18n/useI18n'

const { t, locale } = useI18n()

const props = defineProps({
  collapsed: {
    type: Boolean,
    default: false,
  },
  loading: {
    type: Boolean,
    default: false,
  },
  items: {
    type: Array,
    default: () => [],
  },
  activeId: {
    type: String,
    default: '',
  },
  exportingId: {
    type: String,
    default: '',
  },
})

const emit = defineEmits(['toggle', 'replay', 'export', 'remove', 'open-settings'])

const thumbAlt = (item) =>
  t('history.thumbAlt', {
    source: item.sourceName,
    target: item.targetName,
  })

const titleArrow = (item) =>
  t('history.titleArrow', {
    source: item.sourceName,
    target: item.targetName,
  })

const formatHistoryTimestamp = (value) => formatTimestamp(value, locale.value)

const isRecordLocked = (item) => Boolean(item?.isDeleting || item?.isExiting)

const requestReplay = (item) => {
  if (isRecordLocked(item)) return
  emit('replay', item.id)
}

const requestExport = (item) => {
  if (isRecordLocked(item) || props.exportingId === item.id) return
  emit('export', item.id)
}

const requestRemove = (item) => {
  if (isRecordLocked(item)) return
  emit('remove', item.id)
}

const CONTENT_FADE_DURATION = 180
const LAYOUT_TRANSITION_DURATION = 260

const displayedCollapsed = ref(props.collapsed)
const contentVisible = ref(true)
const isTransitioning = ref(false)

let toggleCommitTimer = null
let layoutSwitchTimer = null
let contentRevealTimer = null

const clearCollapseTimers = () => {
  if (toggleCommitTimer) {
    clearTimeout(toggleCommitTimer)
    toggleCommitTimer = null
  }

  if (layoutSwitchTimer) {
    clearTimeout(layoutSwitchTimer)
    layoutSwitchTimer = null
  }

  if (contentRevealTimer) {
    clearTimeout(contentRevealTimer)
    contentRevealTimer = null
  }
}

const requestToggle = () => {
  if (isTransitioning.value) return

  clearCollapseTimers()
  isTransitioning.value = true
  contentVisible.value = false

  toggleCommitTimer = setTimeout(() => {
    emit('toggle')
    toggleCommitTimer = null
  }, CONTENT_FADE_DURATION)
}

watch(
  () => props.collapsed,
  (nextCollapsed, previousCollapsed) => {
    if (nextCollapsed === previousCollapsed) return

    clearCollapseTimers()
    isTransitioning.value = true
    contentVisible.value = false

    layoutSwitchTimer = setTimeout(async () => {
      displayedCollapsed.value = nextCollapsed
      layoutSwitchTimer = null

      await nextTick()

      contentRevealTimer = setTimeout(() => {
        contentVisible.value = true
        isTransitioning.value = false
        contentRevealTimer = null
      }, 24)
    }, LAYOUT_TRANSITION_DURATION)
  },
)

onBeforeUnmount(() => {
  clearCollapseTimers()
})
</script>

<template>
  <aside class="history" :class="{ collapsed: props.collapsed, 'is-transitioning': isTransitioning }">
    <div class="history-content-shell" :class="{ 'is-hidden': !contentVisible }">
      <div v-if="displayedCollapsed" class="collapsed-actions">
        <button
          type="button"
          class="collapsed-toggle"
          :aria-label="t('history.expand')"
          :title="t('history.expand')"
          :disabled="isTransitioning"
          @click="requestToggle"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 3V9H9" />
            <path d="M12 7V12L15.5 14.5" />
          </svg>
        </button>

        <button
          type="button"
          class="collapsed-settings"
          :aria-label="t('history.openSettings')"
          :title="t('history.settings')"
          :disabled="isTransitioning"
          @click="emit('open-settings')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M19.2 13.4a7.9 7.9 0 0 0 0-2.8l2-1.6-2-3.4-2.4.8a8.1 8.1 0 0 0-2.4-1.4L14 2h-4l-.4 2.9a8.1 8.1 0 0 0-2.4 1.4l-2.4-.8-2 3.4 2 1.6a7.9 7.9 0 0 0 0 2.8l-2 1.6 2 3.4 2.4-.8a8.1 8.1 0 0 0 2.4 1.4L10 22h4l.4-2.9a8.1 8.1 0 0 0 2.4-1.4l2.4.8 2-3.4-2-1.6Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>

      <section v-else class="history-expanded">
        <div class="history-head">
          <strong>{{ t('history.title') }}</strong>
          <button
            type="button"
            class="fold fold-icon"
            :aria-label="t('history.collapse')"
            :title="t('history.collapse')"
            :disabled="isTransitioning"
            @click="requestToggle"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15 6L9 12L15 18" />
            </svg>
          </button>
        </div>

        <div class="history-body">
          <div v-if="props.loading" class="history-skeleton" aria-hidden="true">
            <article v-for="n in 4" :key="n" class="record-skeleton">
              <div class="thumb-skeleton skeleton-shimmer" />
              <div class="info-skeleton">
                <div class="line line-lg skeleton-shimmer" />
                <div class="line line-md skeleton-shimmer" />
                <div class="line line-sm skeleton-shimmer" />
              </div>

            </article>
          </div>

          <template v-else>
            <p v-if="props.items.length === 0" class="empty">{{ t('history.empty') }}</p>

            <article
              v-for="item in props.items"
              :key="item.id"
              class="record"
              :class="{
                active: item.id === props.activeId,
                deleting: item.isDeleting,
                exiting: item.isExiting,
                locked: isRecordLocked(item),
              }"
              role="button"
              :aria-disabled="isRecordLocked(item) ? 'true' : null"
              :tabindex="isRecordLocked(item) ? -1 : 0"
              @click="requestReplay(item)"
              @keydown.enter.prevent="requestReplay(item)"
              @keydown.space.prevent="requestReplay(item)"
            >
              <img class="thumb" :src="item.thumbnail" :alt="thumbAlt(item)" />

              <div class="info">
                <div class="title" :title="titleArrow(item)">
                  {{ titleArrow(item) }}
                </div>

                <div class="meta">
                  <span>{{ formatHistoryTimestamp(item.createdAt) }}</span>
                  <span>{{ item.pointCount }} {{ t('history.cellsUnit') }}</span>
                  <span>{{ Number(item.durationSeconds || 0).toFixed(1) }}s</span>
                  <span>{{ item.keyframes?.length || 2 }} {{ t('history.keyframeUnit') }}</span>
                </div>

                <div class="actions">
                  <button
                    type="button"
                    :disabled="props.exportingId === item.id || isRecordLocked(item)"
                    @click.stop="requestExport(item)"
                  >
                    {{ props.exportingId === item.id ? t('history.exporting') : t('history.exportGif') }}
                  </button>
                  <button type="button" class="danger" :disabled="isRecordLocked(item)" @click.stop="requestRemove(item)">{{ t('history.delete') }}</button>
                </div>
              </div>

              <div v-if="item.isDeleting" class="record-delete-mask" aria-hidden="true">
                <span class="delete-spinner" />
                <span>{{ t('history.delete') }}</span>
              </div>
            </article>
          </template>
        </div>

        <div class="history-foot">
          <button type="button" class="settings-btn" @click="emit('open-settings')">{{ t('history.settings') }}</button>
        </div>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.history {
  padding-top: 0.5em;
  padding-bottom: 0.5em;
  display: block;
  width: 100%;
  min-width: 0;
  min-height: 0;
  height: 100%;
  max-width: none;
  overflow: hidden;
  container-type: inline-size;
  border-right: 1px solid var(--line-strong);
  background: linear-gradient(180deg, var(--bg-panel-soft), var(--bg-panel));
  transition: background-color 220ms ease, border-color 220ms ease;
}

.history.collapsed {
  width: 100%;
  min-width: 0;
  height: 100%;
  max-width: none;
}

.history.is-transitioning {
  user-select: none;
}

.history-content-shell {
  min-height: 0;
  height: 100%;
  opacity: 1;
  transform: translateX(0) scale(1);
  filter: blur(0);
  transition:
    opacity 220ms ease,
    transform 240ms cubic-bezier(0.22, 1, 0.36, 1),
    filter 240ms ease;
  will-change: opacity, transform, filter;
}

.history-content-shell.is-hidden {
  opacity: 0;
  transform: translateX(-10px) scale(0.985);
  filter: blur(2px);
  pointer-events: none;
}

.collapsed-actions {
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: center;
  padding: 10px 0;
}

.history-expanded {
  min-height: 0;
  height: 100%;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
}

.collapsed-toggle {
  width: 32px;
  height: 32px;
  margin: 0;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-main);
  display: grid;
  place-items: center;
}

.collapsed-toggle:hover,
.collapsed-settings:hover {
  border-color: var(--accent);
}

.collapsed-settings {
  width: 32px;
  height: 32px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-main);
  display: grid;
  place-items: center;
  padding: 0;
}

.collapsed-settings svg {
  width: 16px;
  height: 16px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.collapsed-toggle svg,
.fold-icon svg {
  width: 16px;
  height: 16px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.history-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  border-bottom: 1px solid var(--line-strong);
  color: var(--text-main);
}

.fold {
  border: 1px solid var(--line-strong);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-main);
  border-radius: 8px;
  padding: 5px 10px;
}

.fold-icon {
  width: 28px;
  height: 28px;
  padding: 0;
  display: grid;
  place-items: center;
  font-size: 12px;
}

.history-body {
  min-height: 0;
  max-height: 100%;
  padding: 10px;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-gutter: stable both-edges;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
}

.history-body > * {
  flex: 0 0 auto;
  min-width: 0;
}

.history-foot {
  border-top: 1px solid var(--line-strong);
  padding: 10px;
}

.settings-btn {
  width: 100%;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  padding: 7px 10px;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-main);
}

.settings-btn:hover {
  border-color: var(--accent);
}

.history-skeleton {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.record-skeleton {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: minmax(72px, 88px) minmax(0, 1fr);
  gap: 10px;
  min-height: 112px;
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  padding: 8px;
  background: rgba(255, 255, 255, 0.03);
  transition: grid-template-columns 220ms ease, transform 220ms ease, opacity 220ms ease;
}

.thumb-skeleton {
  width: 88px;
  height: 88px;
  border-radius: 8px;
  transition: width 220ms ease, height 220ms ease;
}

.info-skeleton {
  display: grid;
  gap: 8px;
  align-content: center;
}

.line {
  height: 10px;
  border-radius: 999px;
}

.line-lg {
  width: 90%;
}

.line-md {
  width: 70%;
}

.line-sm {
  width: 55%;
}

.skeleton-shimmer {
  background: linear-gradient(
    100deg,
    rgba(255, 255, 255, 0.08) 20%,
    rgba(255, 255, 255, 0.18) 40%,
    rgba(255, 255, 255, 0.08) 60%
  );
  background-size: 200% 100%;
  animation: skeleton-slide 1.15s ease-in-out infinite;
}

@keyframes skeleton-slide {
  0% {
    background-position: 200% 0;
  }

  100% {
    background-position: -200% 0;
  }
}

.empty {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
  line-height: 2.0;
  text-align: center;
}

.record {
  flex: 0 0 auto;
  position: relative;
  display: grid;
  grid-template-columns: minmax(72px, 88px) minmax(0, 1fr);
  gap: 10px;
  min-height: 112px;
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  padding: 8px;
  cursor: pointer;
  outline: none;
  overflow: hidden;
  max-height: 540px;
  transition:
    grid-template-columns 220ms ease,
    transform 220ms ease,
    opacity 220ms ease,
    max-height 240ms ease,
    padding 240ms ease,
    border-color 180ms ease,
    background-color 180ms ease;
}

.record:hover {
  border-color: var(--accent-border);
}

.record:focus-visible {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.record.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.record.locked {
  cursor: default;
}

.record.deleting {
  border-color: color-mix(in srgb, var(--accent-border) 56%, var(--line-soft));
}

.record.deleting .thumb,
.record.deleting .info {
  opacity: 0.42;
}

.record.exiting {
  opacity: 0;
  transform: translateX(-22px) scale(0.985);
  min-height: 0;
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  border-color: transparent;
}

.thumb {
  width: 88px;
  height: 88px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--line-strong);
  background: var(--bg-card);
  transition: width 220ms ease, height 220ms ease;
}

.info {
  min-width: 0;
  display: grid;
  grid-template-rows: auto auto auto;
  align-content: start;
  gap: 7px;
}

.title {
  font-weight: 600;
  color: var(--text-main);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
}

.meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 10px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--text-muted);
  transition: gap 220ms ease;
}

.actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
  transition: gap 220ms ease;
}

.actions button {
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  padding: 4px 8px;
  width: 100%;
  min-width: 0;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-main);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.actions .danger {
  border-color: var(--danger-border);
  background: var(--danger-bg);
  color: var(--danger-text);
  font-weight: 700;
  opacity: 1;
  transition:
    background-color 160ms ease,
    border-color 160ms ease,
    color 160ms ease;
}

.actions .danger:hover {
  border-color: var(--danger-border-hover);
  background: var(--danger-bg-hover);
  color: var(--danger-text-hover);
}

.record-delete-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: color-mix(in srgb, var(--bg-panel) 84%, transparent);
  color: var(--text-main);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
  backdrop-filter: blur(2px);
}

.delete-spinner {
  width: 13px;
  height: 13px;
  border-radius: 999px;
  border: 2px solid color-mix(in srgb, var(--accent) 22%, transparent);
  border-top-color: var(--accent);
  animation: history-delete-spin 720ms linear infinite;
}

@keyframes history-delete-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes history-stack-in {
  0% {
    opacity: 0.82;
    transform: translateY(5px);
  }

  100% {
    opacity: 1;
    transform: translateY(0);
  }
}

@container (max-width: 420px) {
  .record-skeleton,
  .record {
    grid-template-columns: 1fr;
    min-height: 198px;
    animation: history-stack-in 220ms ease;
  }

  .thumb-skeleton,
  .thumb {
    width: 100%;
    height: 114px;
  }

  .meta {
    grid-template-columns: 1fr;
    gap: 6px;
  }

  .actions {
    grid-template-columns: 1fr;
  }

  .actions button {
    width: 100%;
  }
}

@media (max-width: 840px) {
  .history {
    width: 100%;
    border-right: none;
    border-bottom: 1px solid var(--line-strong);
    min-width: 100%;
    max-width: 100%;
  }

  .history.collapsed {
    width: 100%;
    min-width: 100%;
    max-width: 100%;
  }
}
</style>
