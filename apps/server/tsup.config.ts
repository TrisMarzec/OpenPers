import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// The release version lives in the root package.json (bumped by `npm version`).
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  entry: ['src/index.ts', 'src/seed-demo.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  noExternal: ['@openpers/shared'],
  clean: true,
  sourcemap: true,
  define: { __OPENPERS_VERSION__: JSON.stringify(version) },
});
