import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
// @ts-expect-error The project has no Node type definitions; these two calls need none
import { existsSync, readFileSync } from 'node:fs'

// The Quest Browser allows VR only over HTTPS. `bun run certs` makes a local certificate;
// with it, the dev server serves HTTPS to the local network so the headset can open it.
const secure = existsSync('certs/key.pem') && existsSync('certs/cert.pem')

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: secure
    ? {
        host: true,
        https: { key: readFileSync('certs/key.pem'), cert: readFileSync('certs/cert.pem') }
      }
    : {}
})
