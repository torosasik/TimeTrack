import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    // Tailwind v4 via Vite plugin
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), './src'),
    },
  },
  base: '/',
  server: {
    port: 5173,
    host: '127.0.0.1',
    open: true,
  },
  build: {
    outDir: 'build_output',
    sourcemap: false,
    assetsDir: 'assets',
    // Firebase Firestore has a real ~500-550 kB floor (made larger by the
    // offline-persistence cache added in Layer 2) that cannot be split further
    // without route-level code splitting. 700 keeps the warning meaningful for
    // genuine regressions while accepting the unavoidable Firebase size.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      input: {
        main: './index.html',
      },
      output: {
        // Function form matches by node_modules path (more robust than exact-id
        // lists) and auto-catches all installed @radix-ui/* packages.
        manualChunks(id) {
          if (!id.includes('node_modules')) return; // app code stays in main
          // Firestore lives at both `firebase/firestore` (thin re-export) and
          // `firebase/node_modules/@firebase/firestore` (the ~550 kB actual
          // code, hoisted under firebase). Isolate both so the heavy Firestore
          // engine + persistence cache is its own cacheable chunk, separate
          // from the small firebase-core (app + auth).
          if (
            id.includes('node_modules/firebase/firestore') ||
            id.includes('node_modules/@firebase/firestore') ||
            (id.includes('node_modules/firebase/node_modules/@firebase/firestore'))
          ) return 'firebase-firestore';
          if (id.includes('node_modules/firebase/')) return 'firebase-core'; // app + auth
          if (id.includes('node_modules/@radix-ui/')) return 'radix-ui';
          return 'vendor'; // lucide-react, date-fns, sonner, cva, clsx, etc.
        },
      },
    },
  },
});
