import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Same default as the test:db:deploy script; override both with TEST_DATABASE_URL.
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgresql://homelab:homelab-dev@127.0.0.1:5432/homelab_test';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    // e2e tests and integration tests that need the real (test) database
    include: ['**/*.e2e-spec.ts', '**/*.int-spec.ts'],
    exclude: ['**/node_modules/**', 'dist/**', 'src/generated/**'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl,
      SETUP_TOKEN_FILE: '.dev/setup-token.test',
    },
    // One shared test database: run files one after another.
    fileParallelism: false,
  },
});
