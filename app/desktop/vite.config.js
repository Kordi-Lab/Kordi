import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { resolveCloudDevApiBase } from './scripts/cloud-dev-endpoint.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

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
              { name: 'vendor', test: /(?:^|[\\/])node_modules[\\/]/ },
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
              { name: 'desktop-features', test: /[\\/]src[\\/]features[\\/]/ },
              { name: 'workspace-ui', test: /[\\/]src[\\/](?:app|components|kordi-app|pages)[\\/]/ },
            ],
          },
        },
      },
    },
  }
})
