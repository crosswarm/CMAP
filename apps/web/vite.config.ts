import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const api = `http://127.0.0.1:${process.env['CMAP_API_PORT'] ?? 8787}`
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    cors: false,
    allowedHosts: ['localhost', '127.0.0.1'],
    proxy: {
      '/v1': {
        target: api,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (outgoing, incoming) => {
            // 仅替换确定的本地开发页面来源；其他 Origin 原样交给 API 拒绝。
            if (
              ['http://127.0.0.1:5173', 'http://localhost:5173'].includes(
                incoming.headers.origin ?? '',
              )
            ) {
              outgoing.setHeader('origin', api)
            }
          })
        },
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
