import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `vite` alone serves the web app on :5173 and proxies the API to a server started with
// `bun server.ts` on :8090. `vite build` writes dist/, which server.ts serves itself.
export default defineConfig({
    root: 'web',
    plugins: [react()],
    build: {
        outDir: '../dist',
        emptyOutDir: true,
    },
    server: {
        proxy: {
            '/livequery': { target: 'http://localhost:8091', ws: true },
        },
    },
    worker: {
        format: 'es',
    },
    optimizeDeps: {
        include: ['rxjs', 'rxjs/operators'],
    },
})
