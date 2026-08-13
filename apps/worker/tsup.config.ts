import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  clean: true,
  /**
   * Workspace packages are external by default; bundle `@ingestio/shared`
   * so `node dist/index.js` runs without resolving the shared package's
   * TypeScript source at runtime (its `exports` points at `src/index.ts`).
   * Path aliases (@ingestio/lib/*, @ingestio/workers/*) are already inlined.
   */
  noExternal: ['@ingestio/shared'],
});
