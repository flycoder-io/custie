import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.ts', index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  external: ['playwright', 'better-sqlite3'],
});
