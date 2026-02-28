import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import electronRenderer from 'vite-plugin-electron-renderer';
import path from 'path';

export default defineConfig(() => {
  const webOnly = process.env.TRUSS_DISABLE_ELECTRON === '1';

  return {
    plugins: [
      react(),
      ...(!webOnly ? [
        electron([
          {
            entry: 'src/main/main.ts',
            vite: {
              build: {
                outDir: 'dist/main',
                rollupOptions: {
                  external: ['electron'],
                },
              },
            },
          },
          {
            entry: 'src/main/preload.ts',
            onstart(args) {
              args.reload();
            },
            vite: {
              build: {
                outDir: 'dist/preload',
              },
            },
          },
        ]),
        electronRenderer(),
      ] : []),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    root: '.',
    build: {
      outDir: 'dist/renderer',
    },
  };
});
