import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ['better-sqlite3', '@modelcontextprotocol/sdk'],
  noExternal: ['@engine/core'],
});
