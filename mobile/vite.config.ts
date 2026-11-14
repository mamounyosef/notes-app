import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const nm = (p: string) => fileURLToPath(new URL(`../node_modules/${p}`, import.meta.url))

// The phone build: the mobile shell plus the desktop editor from ../src.
export default defineConfig({
  root,
  base: './',
  resolve: {
    // One copy of each shared library (the shell sits in its own folder).
    dedupe: ['react', 'react-dom', 'zustand', '@tiptap/core', '@tiptap/pm', '@tiptap/react', 'katex'],
    alias: [
      { find: /^vendor-chart-umd/, replacement: nm('chart.js/dist/chart.umd.min.js') },
      { find: /^vendor-katex-umd/, replacement: nm('katex/dist/katex.min.js') },
    ],
  },
  plugins: [react()],
  build: {
    outDir: 'www',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
  server: { port: 5290, strictPort: false, fs: { allow: ['..'] } },
})
