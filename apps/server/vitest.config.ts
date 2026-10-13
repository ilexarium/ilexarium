import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    // The root wrapper's tests too (system/ has no package of its own; they need no database).
    include: ['**/*.spec.ts', '../../system/wrappers/*.spec.ts'],
  },
});
