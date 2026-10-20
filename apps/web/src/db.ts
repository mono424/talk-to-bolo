import type { SyncedDbConfig } from '@spooky-sync/client-solid';
import { schema, SURQL_SCHEMA } from './schema.gen';

// VITE_DB_* are baked in by `spky deploy` on the free (Cloudflare) plan from
// the external SurrealDB in sp00ky.yml; `spky dev` serves the local stack.
export const dbConfig: SyncedDbConfig<typeof schema> = {
  logLevel: import.meta.env.DEV ? 'info' : 'warn',
  schema,
  schemaSurql: SURQL_SCHEMA,
  // SQLite-WASM in a worker, persisted in OPFS, one store shared by every tab.
  localEngine: 'sqlite',
  sharedTabs: true,
  database: {
    namespace: import.meta.env.VITE_DB_NS || 'main',
    database: import.meta.env.VITE_DB_DB || 'studycall',
    endpoint: import.meta.env.VITE_DB_ENDPOINT || 'ws://localhost:8666/rpc',
    store: 'indexeddb',
  },
};
