import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Dev server + demo bundler. Vite serves `demo/` during `npm run dev`
// and emits a static build into `demo-dist/` for GitHub Pages. The
// package itself does not use Vite to build — `tsc -p tsconfig.build.json`
// emits `dist/`. See `package.json` scripts.
export default defineConfig({
  root: path.resolve(__dirname, 'demo'),
  // GitHub Pages serves the demo under a subpath — the deploy workflow
  // sets VITE_BASE so asset URLs get the right prefix. Local dev
  // (no env var) falls back to `/`.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  resolve: {
    // Alias package self-imports so demo code reads exactly like a
    // consumer's would, without needing a link or a publish step.
    // Regex aliases anchor on exact specifier so `@atomic-editor/editor`
    // doesn't prefix-match `@atomic-editor/editor/code-languages`.
    alias: [
      {
        find: /^@atomic-editor\/editor$/,
        replacement: path.resolve(__dirname, 'src/index.ts'),
      },
      {
        find: /^@atomic-editor\/editor\/code-languages$/,
        replacement: path.resolve(__dirname, 'src/code-languages.ts'),
      },
      {
        find: /^@atomic-editor\/editor\/styles\.css$/,
        replacement: path.resolve(__dirname, 'src/styles/inline-preview.css'),
      },
    ],
  },
  build: {
    outDir: path.resolve(__dirname, 'demo-dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
