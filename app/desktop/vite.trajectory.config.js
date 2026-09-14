import { defineConfig } from 'vite';
import desktopConfig from './vite.config.js';

// Exercise the real transcript with the same minification as the native bundle.
export default defineConfig(env => {
  const config = desktopConfig(env);
  return {
    ...config,
    build: {
      ...config.build,
      outDir: 'dist/trajectory',
      rolldownOptions: {
        ...config.build.rolldownOptions,
        input: 'tests/visual/processingTrajectory.html',
      },
    },
  };
});
