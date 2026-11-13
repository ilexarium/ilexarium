import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    // The root wrapper's and the release scripts' tests too (system/ and scripts/ have no package
    // of their own; they need no database).
    include: ['**/*.spec.ts', '../../system/programs/*.spec.ts', '../../scripts/lib/*.spec.ts'],
  },
});
