# Studycall repository guidance

See README.md for what the app is and how it is deployed.

## Writing style

Never use long dashes (em dashes) anywhere: UI text, comments, commits, docs.
Use a comma, period, colon or a plain hyphen.

## Schema

- `schema/src/schema.surql` is the sp00ky schema. sp00ky's parser predates
  SurrealDB 3 syntax for search indexes and refuses indexes on fields clients
  cannot read, so those live in `apps/api/src/server-schema.surql`, which the
  Worker applies idempotently. Indexes there use `IF NOT EXISTS`: redefining
  one rebuilds it.
- After editing the sp00ky schema: `pnpm generate`, then
  `spky migrate create <name> --path dev`, then check the new migration for
  `'[REDACTED]'` (see README) before applying it.
- Record ids minted by the app start with a letter and have no dashes
  (`newId` in `apps/web/src/lib/ids.ts`, `k<uuid hex>` in the Worker), so they
  never need ⟨⟩ quoting.

## Web app (`apps/web`)

Every read is a named live query in `src/lib/query.ts`, registered with
`useQuery`. No one-shot remote reads from the client. Calls to the API Worker
go through `src/lib/api.ts` with the user's SurrealDB token. After a local
write the API must read, `await whenSynced(db)` first.

## API Worker (`apps/api`)

- SurrealDB over HTTP JSON-RPC (`src/surreal.ts`). `Surreal.system` acts as the
  API's database user and must filter by owner explicitly; `Surreal.as(token)`
  runs with the user's own permissions. Record ids travel as strings and
  become records with `type::record($id)`; bytes travel as base64. Null vars
  are dropped (NONE), never sent as NULL.
- Never share a pending promise across requests (a Worker may not await I/O
  another request started): per-isolate caches hold values or flags only.
- Claude calls use `FALLBACK` from `src/claude.ts` (server-side refusal
  fallback) and check `stop_reason === 'refusal'`.
