import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'

const nm = (p: string) => fileURLToPath(new URL(`./node_modules/${p}`, import.meta.url))

export default defineConfig({
  base: './',
  resolve: {
    // Library builds that HTML blocks load inside their sandbox (their package exports hide them).
    alias: [
      { find: /^vendor-chart-umd/, replacement: nm('chart.js/dist/chart.umd.min.js') },
      { find: /^vendor-katex-umd/, replacement: nm('katex/dist/katex.min.js') },
    ],
  },
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            // Diagram engines load their WebAssembly from their own folders at run time.
            rollupOptions: { external: ['electron', 'node-tikzjax', '@hpcc-js/wasm-graphviz'] },
          },
        },
      },
      preload: {
        input: 'electron/preload.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: { external: ['electron'] },
          },
        },
      },
    }),
  ],
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5273,
    strictPort: false,
  },
})
