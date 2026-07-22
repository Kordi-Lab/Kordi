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
              { name: 'vendor', test: /(?:^|[\\/])node_modules[\\/]/ },
              { name: 'agent-factory', test: /[\\/]src[\\/]kordi-app[\\/]agents[\\/]/ },
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
