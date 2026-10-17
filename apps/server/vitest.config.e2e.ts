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
      // Created with development defaults if missing; test/services.e2e-spec.ts writes its own.
      WRAPPER_CONFIG_FILE: '.dev/wrappers.test.json',
      MASTER_KEY_FILE: '.dev/master.test.key',
      // The dev Docker socket proxy (npm run db:up); tests needing it are skipped when it's down.
      DOCKER_HOST: process.env.TEST_DOCKER_HOST ?? 'tcp://127.0.0.1:2375',
      // The health alerts' watcher would write alerts while tests empty the tables; its rules
      // have unit tests (src/alerts/*.spec.ts).
      ALERTS_WATCH: 'off',
    },
    // One shared test database: run files one after another.
    fileParallelism: false,
  },
});
