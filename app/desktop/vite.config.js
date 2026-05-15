import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        codeSplitting: {
          minSize: 20_000,
          groups: [
            { name: 'editor-vendor', test: /[\\/]node_modules[\\/](@tiptap|tiptap-markdown|prosemirror-.+)[\\/]/ },
            { name: 'canvas-vendor', test: /[\\/]node_modules[\\/](tldraw|@tldraw|hotkeys-js|core-js)[\\/]/ },
            { name: 'download-vendor', test: /[\\/]node_modules[\\/](pdfmake|docx|fontkit|@xmldom|pako|jszip|xmlbuilder)[\\/]/ },
            { name: 'vendor', test: /(?:^|[\\/])node_modules[\\/]/ },
            { name: 'desktop-features', test: /[\\/]src[\\/]features[\\/]/ },
            { name: 'workspace-ui', test: /[\\/]src[\\/](?:app|components|kordi-app|pages)[\\/]/ },
          ],
        },
      },
    },
  },
})
