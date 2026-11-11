import { build } from 'esbuild'

await build({
  entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  external: ['electron'],
  sourcemap: false,
})
