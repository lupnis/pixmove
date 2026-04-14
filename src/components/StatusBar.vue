<script setup>
import { useI18n } from '../i18n/useI18n'

const { t } = useI18n()

const props = defineProps({
  statusText: {
    type: String,
    default: 'Standby',
  },
  stageText: {
    type: String,
    default: 'Idle',
  },
  positionText: {
    type: String,
    default: '0.00s / 0.00s',
  },
  progress: {
    type: Number,
    default: 0,
  },
  density: {
    type: Number,
    default: 8,
  },
  densityMax: {
    type: Number,
    default: 12,
  },
  effectiveResolution: {
    type: Number,
    default: 38,
  },
  busy: {
    type: Boolean,
    default: false,
  },
  canStopGenerate: {
    type: Boolean,
    default: false,
  },
  stopLabel: {
    type: String,
    default: 'Stop',
  },
  canGenerate: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['generate', 'stop-generate', 'update:density'])

const onDensityChange = (event) => {
  emit('update:density', Number(event.target.value))
}
</script>

<template>
  <footer class="status-bar">
    <div class="meta">
      <div class="item">
        <span class="key">{{ t('statusBar.state') }}</span>
        <span class="value">{{ statusText || t('workflow.standby') }}</span>
      </div>
      <div class="item">
        <span class="key">{{ t('statusBar.stage') }}</span>
        <span class="value">{{ stageText || t('workflow.standby') }}</span>
      </div>
      <div class="item">
        <span class="key">{{ t('statusBar.position') }}</span>
        <span class="value">{{ positionText }}</span>
      </div>
    </div>

    <div class="ops">
      <label class="density-box">
        <span class="key">{{ t('statusBar.targetResolution') }}</span>
        
        <!-- <span class="density-value">/span> -->
        <span class="density-value">{{ density.toFixed(1) }}% ({{ effectiveResolution }} x {{ effectiveResolution }})</span>
        <input
          class="density-slider density-hint"
          type="range"
          min="4"
          :max="densityMax"
          :step="densityMax > 100 ? 1 : 0.5"
          :disabled="busy"
          :value="density"
          @input="onDensityChange"
        />
      </label>

      <div class="progress-wrap">
        <div class="progress-track">
          <div class="progress-value" :style="{ width: `${Math.max(0, Math.min(100, progress))}%` }" />
        </div>
        <span class="percent">{{ Math.round(progress) }}%</span>
      </div>

      <div class="action-buttons">
        <button type="button" class="generate-btn" :disabled="busy || !canGenerate" @click="emit('generate')">
          {{ busy ? t('statusBar.processing') : t('statusBar.startGenerate') }}
        </button>

        <button
          v-if="canStopGenerate"
          type="button"
          class="stop-btn"
          @click="emit('stop-generate')"
        >
          {{ stopLabel }}
        </button>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.status-bar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 7px 12px;
  border-top: 1px solid var(--line-strong);
  background: linear-gradient(90deg, var(--bg-panel-soft), var(--bg-panel));
}

.meta {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.item {
  min-width: 0;
  display: grid;
  gap: 1px;
}

.key {
  color: var(--text-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.value {
  color: var(--text-main);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ops {
  display: grid;
  grid-template-columns: minmax(200px, 250px) minmax(180px, 260px) auto;
  gap: 28px;
  align-items: center;
}

.density-box {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 6px;
  align-items: center;
}

.density-slider {
  width: 100%;
}

.density-value {
  min-width: 46px;
  text-align: right;
  color: var(--text-main);
  font-weight: 600;
  font-size: 12px;
}

.density-hint {
  grid-column: 1 / -1;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1;
}

.progress-wrap {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  align-items: center;
}

.progress-track {
  height: 6px;
  border-radius: 999px;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  background: rgba(255, 255, 255, 0.05);
}

.progress-value {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-strong));
}

.percent {
  font-size: 12px;
  color: var(--text-main);
  min-width: 38px;
  text-align: right;
}

.generate-btn {
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  padding: 6px 16px;
  font: inherit;
  color: var(--text-main);
  border-color: var(--accent-border);
  background: var(--accent-soft);
  font-weight: 700;
  white-space: nowrap;
}

.stop-btn {
  border: 1px solid var(--danger-border);
  border-radius: 6px;
  padding: 6px 10px;
  font: inherit;
  background: var(--danger-bg);
  color: var(--danger-text);
  font-weight: 700;
  white-space: nowrap;
  opacity: 1;
  transition:
    background-color 160ms ease,
    border-color 160ms ease,
    color 160ms ease;
}

.stop-btn:hover {
  border-color: var(--danger-border-hover);
  background: var(--danger-bg-hover);
  color: var(--danger-text-hover);
}

.action-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: nowrap;
}

.generate-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

@media (max-width: 1240px) {
  .meta {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .ops {
    grid-template-columns: minmax(180px, 1fr) minmax(180px, 1fr) auto;
  }
}

@media (max-width: 1100px) {
  .status-bar {
    grid-template-columns: 1fr;
  }

  .ops {
    grid-template-columns: minmax(180px, 1fr) minmax(180px, 1fr) auto;
  }
}

@media (max-width: 920px) {
  .meta {
    grid-template-columns: 1fr;
  }

  .ops {
    grid-template-columns: 1fr;
  }
}

@media (max-height: 860px) {
  .status-bar {
    gap: 8px;
    padding: 6px 10px;
  }

  .density-hint {
    display: none;
  }
}
</style>
