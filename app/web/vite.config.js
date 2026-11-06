import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import { desktopViteConfig } from '../desktop/vite.config.js'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ command, mode }) => {
  const env = { ...loadEnv(mode, root, ''), ...process.env }
  // A host-only browser session needs an API on the frontend's origin. Local
  // development can proxy only to a loopback development backend.
  const proxyTarget = command === 'serve' ? env.KORDI_WEB_API_PROXY_TARGET : undefined
  if (proxyTarget) {
    const target = new URL(proxyTarget)
    if (!['http:', 'https:'].includes(target.protocol)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
      || target.username || target.password || target.search || target.hash || target.pathname !== '/') {
      throw new Error('KORDI_WEB_API_PROXY_TARGET must be a loopback HTTP(S) origin.')
    }
  }
  const shared = desktopViteConfig({ command, mode }, env)
  return {
    ...shared,
    root,
    base: '/app/',
    publicDir: path.resolve(root, '../desktop/public'),
    define: { ...shared.define, 'import.meta.env.VITE_KORDI_WEB_APP': JSON.stringify('1') },
    server: {
      host: '127.0.0.1',
      ...(proxyTarget ? { proxy: {
        '/v1': { target: proxyTarget, ws: true, changeOrigin: false },
        '/v2': { target: proxyTarget, ws: true, changeOrigin: false },
      } } : {}),
    },
    build: { ...shared.build, outDir: path.resolve(root, 'dist') },
  }
})
