import { defineConfig, env } from 'prisma/config';

// Prisma 7 doesn't read .env itself; Node does. A missing file is fine (CI, production env vars).
try {
  process.loadEnvFile('.env');
} catch {
  // no .env file
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
