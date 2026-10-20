import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = import.meta.dirname;

// The Karto server is chosen at pairing (no host permission: the API answers CORS). VITE_API_URL, when set, only
// prefills the pairing screen.
export default defineConfig(({ mode }) => ({
  root,
  oxc: { jsx: { runtime: 'automatic' } },
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: mode === 'development',
    rolldownOptions: {
      input: {
        background: resolve(root, 'src/background/index.ts'),
        sidepanel: resolve(root, 'sidepanel.html'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
}));
