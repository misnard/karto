import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const root = import.meta.dirname;

/** Emits public/manifest.json with the version of package.json, the only place where the version is set. */
function manifest(): Plugin {
  const file = resolve(root, 'public/manifest.json');
  return {
    name: 'karto-manifest',
    async generateBundle() {
      this.addWatchFile(file);
      const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
      const source = JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), version }, null, 2);
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source });
    },
  };
}

// The Karto server is chosen at pairing (no host permission: the API answers CORS). VITE_API_URL, when set, only
// prefills the pairing screen.
export default defineConfig(({ mode }) => ({
  root,
  // public/ only holds the manifest, emitted by the plugin above.
  publicDir: false,
  plugins: [manifest()],
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
