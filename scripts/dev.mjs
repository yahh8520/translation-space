import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import { build } from 'esbuild'
import electron from 'electron'

await build({ entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, external: ['electron'] })
const server = await createServer()
await server.listen()
const env = { ...process.env, BETWEEN_DEV_URL: 'http://127.0.0.1:5173' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['.'], { env, stdio: 'inherit' })
let stopped = false
const stop = async () => { if (stopped) return; stopped = true; child.kill(); await server.close() }
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
child.on('exit', async code => { await stop(); process.exitCode = code ?? 0 })
