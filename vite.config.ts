import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  define: {
    // React and React Flow read process.env.NODE_ENV — replace at build time
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env': '{}',
    'process.platform': JSON.stringify('browser'),
    'process.version': JSON.stringify(''),
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src-frontend/flow-editor/index.tsx'),
      name: 'FlowEditor',
      formats: ['iife'],
      fileName: () => 'flow-editor.js',
    },
    outDir: 'public',
    emptyOutDir: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        assetFileNames: (assetInfo) => {
          if (assetInfo.names?.[0]?.endsWith('.css')) return 'flow-editor.css';
          return assetInfo.names?.[0] ?? 'assets/[name][extname]';
        },
      },
    },
  },
});
