import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  // wasm() is required by @spooky-sync/core, which bundles the loro-crdt,
  // SQLite and SurrealDB WASM modules. Their top-level await needs no plugin:
  // the build targets esnext.
  plugins: [solid(), tailwindcss(), wasm()],
  server: {
    port: 5180,
    strictPort: true,
  },
  build: {
    target: 'esnext',
  },
  optimizeDeps: {
    // Served raw: esbuild pre-bundling breaks each module's own `.wasm` /
    // worker URL lookup (`new URL(..., import.meta.url)`), and the local
    // engine dies behind the loading screen.
    exclude: [
      '@surrealdb/wasm',
      '@surrealdb/wasm-native',
      '@sqlite.org/sqlite-wasm',
      'surrealdb',
      '@spooky-sync/client-solid',
      '@spooky-sync/core',
    ],
    // pino is reached through @spooky-sync/core and is CJS: pre-bundle just it
    // so its default export interop works when core is served raw.
    include: ['@spooky-sync/core > pino'],
    esbuildOptions: {
      target: 'esnext',
    },
  },
  esbuild: {
    supported: {
      'top-level-await': true,
    },
  },
});
