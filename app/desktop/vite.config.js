import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { resolveCloudDevApiBase } from './scripts/cloud-dev-endpoint.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DOCUMENT_EDITOR_SOURCE = /[\\/]src[\\/]features[\\/]documents[\\/]editor[\\/]/;
const DOCUMENT_EDITOR_PACKAGES = /[\\/]node_modules[\\/](?:@tiptap|prosemirror-[a-z-]+|marked|linkifyjs|orderedmap|rope-sequence|w3c-keyname|yjs|y-websocket|y-protocols|lib0)[\\/]/;

export default defineConfig(({ command, mode }) => {
  if (command === 'serve') {
    resolveCloudDevApiBase({
      ...loadEnv(mode, __dirname, ''),
      ...process.env,
    })
  }

  return {
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
              { name: 'calling-media', test: /(?:^|[\\/])node_modules[\\/](?:livekit-client|@livekit|webrtc-adapter|sdp-transform|jose)(?:[\\/]|$)/ },
              // The document editor (its source, Tiptap, ProseMirror, the Markdown parser) is one lazy chunk that loads
              // with the first opened document. Packages the app shares (floating UI, uuid) stay in vendor.
              { name: 'vendor', test: (id) => /(?:^|[\\/])node_modules[\\/]/.test(id) && !DOCUMENT_EDITOR_PACKAGES.test(id) },
              { name: 'emoji-catalog', test: /[\\/]shared[\\/]noto-emoji[\\/]catalog\.json$/ },
              // The add-account login page loads when a sign-in method is opened.
              { name: 'auth-login', minSize: 0, test: /[\\/]src[\\/]kordi-app[\\/]auth[\\/](?:AuthLoginPage\.tsx|useProviderLogin\.ts)$/ },
              // The OMP provider catalog loads on demand for the provider pages.
              { name: 'omp-catalog', test: /[\\/]shared[\\/]omp-catalog[\\/]omp-provider-catalog\.json$/ },
              // Startup preloading and the picker share this leaf dependency.
              // Keep its manifest with the loader to avoid an entry-chunk cycle.
              { name: 'emoji-thumbnails', minSize: 0, test: /[\\/]src[\\/](?:features[\\/]emoji[\\/]notoEmojiThumbnails\.ts|assets[\\/]noto-thumbnails[\\/]manifest\.json)$/ },
              { name: 'agent-studio', test: /[\\/]src[\\/]kordi-app[\\/]agents[\\/](?:AgentStudio(?!Conversation)|factoryAgentUtils|shapeAgent|useAgentBuilderSession|useFactoryBuildRouting)/ },
              { name: 'agent-factory', test: /[\\/]src[\\/]kordi-app[\\/]agents[\\/]/, maxSize: 650_000 },
              { name: 'cloud-features', test: /[\\/]src[\\/]features[\\/]cloud[\\/]/ },
              { name: 'desktop-features', test: (id) => /[\\/]src[\\/]features[\\/]/.test(id) && !DOCUMENT_EDITOR_SOURCE.test(id) },
              // After the app groups, so modules the app shares with the editor stay in app chunks.
              { name: 'document-editor', test: (id) => DOCUMENT_EDITOR_PACKAGES.test(id) || DOCUMENT_EDITOR_SOURCE.test(id) },
              { name: 'workspace-ui', test: /[\\/]src[\\/](?:app|components|kordi-app|pages)[\\/]/ },
            ],
          },
        },
      },
    },
  }
})
