<script setup>
import { ref } from 'vue'
import { useI18n } from '../i18n/useI18n'

const { t } = useI18n()

const props = defineProps({
  sourceUrl: {
    type: String,
    default: '',
  },
  sourceName: {
    type: String,
    default: '',
  },
  targetUrl: {
    type: String,
    default: '',
  },
  targetName: {
    type: String,
    default: '',
  },
  templates: {
    type: Array,
    default: () => [],
  },
  selectedTemplateId: {
    type: String,
    default: '',
  },
  busy: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['source-file', 'target-file', 'template-change', 'apply-template'])

const sourceInputRef = ref(null)
const targetInputRef = ref(null)

const pickSource = () => sourceInputRef.value?.click()
const pickTarget = () => targetInputRef.value?.click()

const onSourceChange = (event) => {
  const file = event.target.files?.[0]
  if (file) emit('source-file', file)
  event.target.value = ''
}

const onTargetChange = (event) => {
  const file = event.target.files?.[0]
  if (file) emit('target-file', file)
  event.target.value = ''
}

const onTemplateChange = (event) => {
  emit('template-change', event.target.value)
}
</script>

<template>
  <section class="pair-panel">
    <article class="image-card">
      <header>
        <strong>{{ t('imagePair.sourceTitle') }}</strong>
        <span>{{ sourceName || t('imagePair.notLoaded') }}</span>
      </header>

      <div class="canvas-wrap">
        <img v-if="sourceUrl" :src="sourceUrl" :alt="t('imagePair.sourceTitle')" />
        <p v-else>{{ t('imagePair.uploadPromptA') }}</p>
      </div>

      <div class="card-controls">
        <button class="ghost" type="button" :disabled="busy" @click="pickSource">{{ t('imagePair.uploadA') }}</button>
        <span class="hint">{{ sourceName || t('imagePair.supportedFormats') }}</span>
        <input ref="sourceInputRef" type="file" accept="image/*" hidden @change="onSourceChange" />
      </div>
    </article>

    <article class="image-card">
      <header>
        <strong>{{ t('imagePair.targetTitle') }}</strong>
        <span>{{ targetName || t('imagePair.notLoaded') }}</span>
      </header>

      <div class="canvas-wrap">
        <img v-if="targetUrl" :src="targetUrl" :alt="t('imagePair.targetTitle')" />
        <p v-else>{{ t('imagePair.uploadPromptBOrTemplate') }}</p>
      </div>

      <div class="card-controls target-controls">
        <div class="control-row">
          <button class="ghost" type="button" :disabled="busy" @click="pickTarget">{{ t('imagePair.uploadB') }}</button>
          <input ref="targetInputRef" type="file" accept="image/*" hidden @change="onTargetChange" />
        </div>

        <div class="control-row template-row">
          <select class="template-select" :disabled="busy" :value="selectedTemplateId" @change="onTemplateChange">
            <option v-for="item in props.templates" :key="item.id" :value="item.id">
              {{ item.name }}
            </option>
          </select>
          <button class="ghost" type="button" :disabled="busy" @click="$emit('apply-template')">{{ t('imagePair.applyTemplate') }}</button>
        </div>

        <span class="hint">{{ targetName || t('imagePair.templateSwitchHint') }}</span>
      </div>
    </article>
  </section>
</template>

<style scoped>
.pair-panel {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-rows: repeat(2, minmax(180px, 1fr));
  gap: 10px;
  overflow: auto;
  align-content: start;
}

.image-card {
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  overflow: auto;
  background: var(--bg-panel);
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  container-type: inline-size;
}

.image-card header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line-soft);
  min-width: 0;
}

.image-card strong {
  flex: 0 0 auto;
  color: var(--text-main);
  font-size: 14px;
  letter-spacing: 0.03em;
  white-space: nowrap;
}

.image-card header span {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}

.canvas-wrap {
  position: relative;
  min-height: 0;
  padding: 8px;
  display: grid;
  place-items: center;
  overflow: hidden;
  background:
    radial-gradient(circle at 25% 15%, rgba(255, 255, 255, 0.08), transparent 45%),
    linear-gradient(130deg, var(--bg-panel-soft), var(--bg-card));
}

.canvas-wrap img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: center;
}

.canvas-wrap p {
  color: var(--text-muted);
  font-size: 13px;
}

.card-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
  padding: 10px 12px 12px;
  border-top: 1px solid var(--line-soft);
  background: var(--bg-panel-soft);
  min-width: 0;
}

.target-controls {
  gap: 10px;
}

.control-row {
  display: flex;
  gap: 8px;
  min-width: 0;
}

.template-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
}

.ghost,
.template-select {
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  padding: 8px 10px;
  font: inherit;
  color: var(--text-main);
  background: var(--bg-card);
  width: 100%;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ghost:hover,
.template-select:hover {
  border-color: var(--accent);
}

.template-select {
  width: 100%;
}

.hint {
  display: block;
  min-width: 0;
  color: var(--text-muted);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@container (max-width: 340px) {
  .control-row,
  .template-row {
    grid-template-columns: 1fr;
    flex-direction: column;
  }

  .ghost,
  .template-select {
    font-size: 12px;
    padding: 7px 8px;
  }
}

@media (max-height: 860px) {
  .pair-panel {
    grid-template-rows: repeat(2, minmax(184px, 1fr));
    gap: 8px;
  }

  .card-controls {
    gap: 6px;
    padding: 8px 10px 10px;
  }

  .ghost,
  .template-select {
    padding: 7px 9px;
    font-size: 12px;
  }
}

@media (max-width: 920px) {
  .pair-panel {
    grid-template-rows: auto auto;
  }

  .control-row,
  .template-row {
    grid-template-columns: 1fr;
    flex-direction: column;
  }
}
</style>
