import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * The iPhone app's document editor page: the Mac's Tiptap editor as one
 * classic script and one stylesheet, loaded from the app bundle by a
 * WKWebView. `scripts/prepare-ios-document-editor.sh` runs this from the
 * Xcode build with `--outDir` inside the app's resources.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  publicDir: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    emptyOutDir: true,
    copyPublicDir: false,
    cssCodeSplit: false,
    sourcemap: false,
    minify: true,
    chunkSizeWarningLimit: 2_000,
    lib: {
      entry: path.resolve(__dirname, 'src/ios-document-editor/main.tsx'),
      formats: ['iife'],
      name: 'KordiDocumentEditor',
      fileName: () => 'document-editor.js',
      cssFileName: 'document-editor',
    },
  },
})
