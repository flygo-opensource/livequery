import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Writes dist/sw.js once the build (including the SharedWorker chunk) is on disk: it precaches
 * every file of the build, so the app opens with no network at all. Its version is a hash of the
 * files, so a new deploy installs a new service worker and drops the old cache.
 */
function serviceWorker(): Plugin {
    const out = new URL('./dist', import.meta.url).pathname
    const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
        const path = join(dir, name)
        return statSync(path).isDirectory() ? files(path) : [path]
    })
    return {
        name: 'chat-demo-service-worker',
        apply: 'build',
        closeBundle() {
            const paths = files(out).filter(path => !path.endsWith('sw.js'))
            const hash = createHash('sha256')
            for (const path of paths) hash.update(readFileSync(path))
            const urls = paths.map(path => `/${relative(out, path)}`)
            const template = readFileSync(new URL('./web/sw.js', import.meta.url), 'utf8')
            writeFileSync(join(out, 'sw.js'), template
                .replace('__VERSION__', hash.digest('hex').slice(0, 12))
                .replace('__FILES__', JSON.stringify(urls)))
        },
    }
}

// `vite` alone serves the web app on :5173 and proxies the API to a server started with
// `bun server.ts` on :8091. `vite build` writes dist/, which server.ts serves itself.
export default defineConfig({
    root: 'web',
    plugins: [react(), serviceWorker()],
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
