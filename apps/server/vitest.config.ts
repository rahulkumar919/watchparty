import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Unit tests run without a DB (fast, always run)
    include: ['src/**/*.test.ts'],
    // Integration tests require DATABASE_URL and are excluded from default `test` run
    exclude: ['src/tests/integration/**', 'src/tests/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['src/index.ts', 'src/db/seed.ts', 'dist/**', 'src/tests/**'],
    },
    isolate: true,
    testTimeout: 10000,
    hookTimeout: 10000,
  },
  resolve: {
    alias: {
      '@watchparty/types': path.resolve(__dirname, '../../packages/types/src/index.ts'),
    },
  },
});
