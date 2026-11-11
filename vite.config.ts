import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command }) => ({
  plugins: [react(), {
    name: 'desktop-content-security-policy',
    transformIndexHtml: () => [{
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content: `default-src 'self'; script-src 'self'${command === 'serve' ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${command === 'serve' ? ' ws://127.0.0.1:5173' : ''}; object-src 'none'; base-uri 'none'; form-action 'none'`,
      },
    }],
  }],
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: 'dist', sourcemap: false },
}))
