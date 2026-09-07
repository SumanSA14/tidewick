import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // node by default; the handful of files that need a DOM opt in with a
    // `@vitest-environment jsdom` docblock. Running everything under jsdom
    // costs ~25s of environment setup per run, which is enough to stop you
    // running the suite as often as you should.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tools/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
  },
})
