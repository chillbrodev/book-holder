import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
  build: {
    // Pinned because of what the CSS minifier does when left alone: it rewrites
    // `@media (max-width: 600px)` into the Level 4 range syntax
    // `@media (width<=600px)`, which is a real saving and is understood from
    // Safari 16.4 on. Vite's default target still includes Safari 16.0, so on
    // iOS 16.0–16.3 every mobile block in the app would parse as invalid and be
    // dropped, and those phones would silently be served the desktop layout.
    // Failing that way on precisely the devices the mobile styles exist for is
    // worth more than the bytes. Verified by building and grepping the emitted
    // CSS for `max-width`.
    cssTarget: 'safari16',
  },
})
