import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const projectRoot = process.cwd();

export default defineConfig({
  root: resolve(projectRoot, 'public-site'),
  publicDir: resolve(projectRoot, 'public'),
  resolve: {
    alias: {
      '@': projectRoot,
    },
  },
  css: {
    postcss: {
      plugins: [tailwindcss()],
    },
  },
  plugins: [react()],
  build: {
    outDir: resolve(projectRoot, 'dist-public'),
    emptyOutDir: true,
  },
});
