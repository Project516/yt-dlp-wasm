import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const wheelDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/yt-dlp-wasm/dist');

// micropip reads the version from the wheel's file name, so it must not be hashed
const keepWheelName = ({ names }) => (names[0]?.endsWith('.whl') ? 'assets/[name][extname]' : 'assets/[name]-[hash][extname]');

export default defineConfig({
  base: '/',
  // The library starts its own module worker, which pre-bundling would break
  optimizeDeps: { exclude: ['@project516/yt-dlp-wasm'] },
  worker: { format: 'es' },
  build: { rollupOptions: { output: { assetFileNames: keepWheelName } } },
  plugins: [{
    name: 'require-wheel',
    buildStart() {
      if (!fs.existsSync(wheelDir) || !fs.readdirSync(wheelDir).some((name) => name.endsWith('.whl'))) {
        this.error('The yt-dlp wheel is missing. Run `pnpm build` in packages/yt-dlp-wasm first.');
      }
    },
  }],
});
