import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { clientBuildEnvironmentDefines } from '../../scripts/client-build-environment.ts'

const src = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url))

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist',
    rollupOptions: { input: src('./index.html') },
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [{ find: /^node:module$/, replacement: src('../web/src/node-module-stub.ts') }],
  },
  define: {
    ...clientBuildEnvironmentDefines(process.env),
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
    'process.env.CORDIS_SHARED': 'undefined',
  },
})
