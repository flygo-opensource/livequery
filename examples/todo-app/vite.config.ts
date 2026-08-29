import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        allowedHosts: ['support-ba.tail7a22dd.ts.net'],
    },
    optimizeDeps: {
        include: ['rxjs', 'rxjs/operators'],
    },
})
