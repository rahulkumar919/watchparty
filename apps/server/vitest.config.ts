import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['src/index.ts', 'src/db/seed.ts', 'dist/**'],
    },
    // Ensure tests get a clean environment
    isolate: true,
    // Set reasonable timeout for integration tests (socket connections)
    testTimeout: 10000,
    hookTimeout: 10000,
  },
  resolve: {
    alias: {
      '@watchparty/types': path.resolve(__dirname, '../../packages/types/src/index.ts'),
    },
  },
});
