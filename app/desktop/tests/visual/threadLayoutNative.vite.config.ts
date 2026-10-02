import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import baseConfig from '../../vite.config.js';

export default defineConfig(env => mergeConfig(baseConfig(env), {
  resolve: { alias: { '@tauri-apps/api/core': fileURLToPath(new URL('./threadLayoutNativeCore.ts', import.meta.url)) } },
  plugins: [{ name: 'synthetic-native-preview-ready', configureServer(server) {
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
