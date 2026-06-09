import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  shims: true,
  external: [
    'better-sqlite3',
    'simple-git',
    'chokidar',
    'glob',
    'yaml',
    'zod',
    'unified',
    'remark-parse',
    'unist-util-visit',
    'js-sha3',
    'p-limit'
  ],
  noExternal: ['@engine/core'],
});


