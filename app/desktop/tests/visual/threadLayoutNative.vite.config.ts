import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import baseConfig from '../../vite.config.js';

export default defineConfig(env => mergeConfig(baseConfig(env), {
  resolve: { alias: { '@tauri-apps/api/core': fileURLToPath(new URL('./threadLayoutNativeCore.ts', import.meta.url)) } },
  plugins: [{ name: 'synthetic-native-preview-ready', configureServer(server) {
    server.middlewares.use('/__synthetic-preview-sidebar', (req, res) => {
      const collapsed = new URL(req.url ?? '/', 'http://localhost').searchParams.get('collapsed');
      if (req.method !== 'POST' || !['true', 'false'].includes(collapsed ?? '')) { res.statusCode = 400; res.end(); return; }
      server.ws.send({ type: 'custom', event: 'synthetic-preview-sidebar', data: { collapsed: collapsed === 'true' } });
      res.end('OK');
    });
    server.middlewares.use('/__synthetic-preview-zoom', (req, res) => {
      const key = new URL(req.url ?? '/', 'http://localhost').searchParams.get('key');
      if (req.method !== 'POST' || !key || !['-', '+', '0'].includes(key)) { res.statusCode = 400; res.end(); return; }
      server.ws.send({ type: 'custom', event: 'synthetic-preview-zoom', data: { key } });
      res.end('OK');
    });
    server.middlewares.use('/__synthetic-preview-ready', (req, res) => {
      let body = '';
      req.on('data', chunk => { body += String(chunk); });
      req.on('end', () => {
        server.config.logger.info(`Synthetic native preview: ${body}`);
        res.end('OK');
      });
    });
  } }],
}));
