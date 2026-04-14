import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import {
	applyComponentTonePalette,
	DEFAULT_COMPONENT_TONE,
	DEFAULT_THEME_MODE,
	normalizeComponentTone,
	normalizeThemeMode,
} from './config/uiSettings'

const applyInitialAppearance = () => {
	if (typeof document === 'undefined') return

	const root = document.documentElement
	const normalizedThemeMode = normalizeThemeMode(DEFAULT_THEME_MODE)
	const prefersDark = typeof window !== 'undefined'
		&& typeof window.matchMedia === 'function'
		&& window.matchMedia('(prefers-color-scheme: dark)').matches

	const appliedTheme = normalizedThemeMode === 'system'
		? (prefersDark ? 'dark' : 'light')
		: normalizedThemeMode

	const normalizedTone = normalizeComponentTone(DEFAULT_COMPONENT_TONE)

	root.setAttribute('data-theme-mode', normalizedThemeMode)
	root.setAttribute('data-theme', appliedTheme)
	root.setAttribute('data-accent-tone', normalizedTone)
	applyComponentTonePalette(normalizedTone, root)
}

applyInitialAppearance()

createApp(App).mount('#app')
