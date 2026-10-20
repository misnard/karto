import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const root = import.meta.dirname;
const outDir = resolve(root, 'dist');

/** Puts the API origin into the manifest host permissions once publicDir has been copied. */
function manifestApiOrigin(apiOrigin: string): Plugin {
  return {
    name: 'karto-manifest-api-origin',
    apply: 'build',
    async closeBundle() {
      const file = resolve(outDir, 'manifest.json');
      const manifest = await readFile(file, 'utf8');
      await writeFile(file, manifest.replaceAll('__API_ORIGIN__', apiOrigin));
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, 'VITE_');
  const apiOrigin = new URL(env.VITE_API_URL ?? 'http://localhost:8787').origin;
  return {
    root,
    oxc: { jsx: { runtime: 'automatic' } },
    plugins: [manifestApiOrigin(apiOrigin)],
    build: {
      outDir,
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
  };
});
