import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@atomic-editor\/editor$/,
        replacement: path.resolve(__dirname, 'src/index.ts'),
      },
      {
        find: /^@atomic-editor\/editor\/code-languages$/,
        replacement: path.resolve(__dirname, 'src/code-languages.ts'),
      },
    ],
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/__tests__/setup.ts'],
    globals: false,
  },
});
