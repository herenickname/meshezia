import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import rootPkg from '../../package.json'

export default defineConfig({
    plugins: [tailwindcss(), vue()],
    define: {
        __APP_VERSION__: JSON.stringify(rootPkg.version),
    },
    server: {
        port: 5173,
        proxy: {
            '/api': 'http://localhost:3000',
            '/ws': {
                target: 'ws://localhost:3000',
                ws: true
            }
        }
    }
})
