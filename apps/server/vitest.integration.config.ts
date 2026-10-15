import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Vitest config for integration tests.
 * These require DATABASE_URL and a live DB connection.
 * Run via: vitest run --config vitest.integration.config.ts
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/tests/integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Run integration suites sequentially — they share a real DB
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
  resolve: {
    alias: {
      '@watchparty/types': path.resolve(__dirname, '../../packages/types/src/index.ts'),
    },
  },
});
