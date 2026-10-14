import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts', 'src/seed-demo.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  noExternal: ['@openpers/shared'],
  clean: true,
  sourcemap: true,
});
