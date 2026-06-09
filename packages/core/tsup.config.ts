import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,          // skip DTS for now — run tsc --emitDeclarationOnly separately
  sourcemap: true,
  clean: true,
  splitting: false,
  external: [
    'better-sqlite3',
    'unified',
    'remark-parse',
    'unist-util-visit',
    'yaml',
    'p-limit',
    'glob',
  ],
});
