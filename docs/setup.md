# Setup and deployment

[Back to TalkToBolo](../README.md)

This guide covers the local stack, voice agent, production deployment, and MCP
access. Workspace packages and deployment resources use the internal
`studycall` name.

## How it fits together

```
 Browser (SolidJS + sp00ky)                         ElevenLabs Agent
   │  live queries / writes ──► SurrealDB ◄── SSP    │  speech <-> text
   │                              ▲                  │
   │  /api/* (Bearer: SurrealDB   │ system + user    │  POST /llm/v1/chat/completions
   │   session token)             │ queries          │  (OpenAI-compatible SSE)
   ▼                              │                  ▼
 API Worker (apps/api, Cloudflare) ───────────────────────────────────────
   /api/calls        start/end a call, ElevenLabs conversation token, recap
   /llm/v1/...       tutor prompt from SurrealDB + hybrid search -> Claude stream
   /api/materials    PDF upload -> Workflow: images (unpdf) -> Markdown (Claude)
                     -> chunks -> embeddings (Workers AI) -> SurrealDB HNSW/BM25
   /assets/:id       images extracted from PDFs
   /mcp              MCP server (Streamable HTTP), personal API keys
```

| Path | What |
| --- | --- |
| [`schema/src/schema.surql`](../schema/src/schema.surql) | The sp00ky schema: users, courses, materials, calls, transcript, API keys, access methods. `spky generate` turns it into `apps/web/src/schema.gen.ts`. |
| `apps/api/src/server-schema.surql` | Server-only tables (search chunks with embeddings, image bytes, PDF parts) and their HNSW/full-text indexes. Applied by the Worker; see the comment at the top. |
| [`apps/web`](../apps/web) | SolidJS app. Every read is a named live query in `src/lib/query.ts`. |
| [`apps/api`](../apps/api) | Cloudflare Worker (Hono): calls, LLM bridge, ingest Workflow, search, assets, MCP. |
| `scripts/setup-voice-agent.ts` | Creates or updates the ElevenLabs agent. |
| `sp00ky.yml` / `dev/sp00ky.yml` | Production (free plan, external SurrealDB) / local development. |

## Accounts you need

- **SurrealDB Cloud** instance running SurrealDB 3.x for production. Local development uses Docker.
- **Sp00ky Cloud** account for deploying the sync node and web app.
- **Cloudflare Workers Paid** account for the configured ingestion Workflow CPU limit and Workers AI embeddings.
- **Anthropic API key** (Claude).
- **ElevenLabs API key** with Agents access.

## Local development

### Database names

The local and production configurations use different namespace/database pairs.
Keep the API Worker and web app pointed at the same pair for each environment.

| Environment | Namespace | Database | Configuration |
| --- | --- | --- | --- |
| Local | `main` | `studycall` | [`dev/sp00ky.yml`](../dev/sp00ky.yml) |
| Production | `studycall` | `main` | [`sp00ky.yml`](../sp00ky.yml) |

The checked-in [`apps/api/wrangler.jsonc`](../apps/api/wrangler.jsonc) defaults
to the local pair. Update its `SURREAL_NS`, `SURREAL_DB`, and `APP_ORIGIN` before
deploying the API to production.

### Start the local stack

Requirements: Node 22.22.0 or newer, pnpm 10.20.0, Docker, and the provider keys above. Run the commands in this guide from the repository root.

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # fill in the keys
pnpm dev                                            # spky dev --path dev
```

`pnpm dev` starts a local SurrealDB (`:8666`), the sp00ky sync node (`:8667`),
the web app (http://localhost:5180) and the API Worker under `wrangler dev`
(`:8787`). In `.dev.vars`, use `SURREAL_URL=http://localhost:8666`,
`SURREAL_USER=root`, `SURREAL_PASS=root`, `SURREAL_NS=main`,
`SURREAL_DB=studycall`, `APP_ORIGIN=http://localhost:5180`.

Voice calls need ElevenLabs to reach your LLM endpoint, so expose the local
Worker and point a dev agent at it:

```bash
cloudflared tunnel --url http://localhost:8787
```

Use the same `LLM_SHARED_SECRET` value in the command below and in
`apps/api/.dev.vars` so the voice agent can authenticate with the Worker.

```bash
ELEVENLABS_API_KEY=... API_URL=https://YOUR-TUNNEL.trycloudflare.com LLM_SHARED_SECRET=your-shared-secret pnpm setup:voice
```

Put the printed agent id in `.dev.vars` as `ELEVENLABS_AGENT_ID`.

If `spky dev` reports port 8787 in use, a `wrangler dev` from an earlier run
is still alive (stopping `spky dev` does not always stop it):
`lsof -ti tcp:8787 | xargs kill`.

After a schema change: `pnpm generate`, then `pnpm exec spky migrate create migration-name --path dev`.
**Open the new migration and check for `'[REDACTED]'`** before applying it: the
CLI copies access-method JWT keys from a redacted `INFO`, and a key literally
set to `[REDACTED]` lets anyone sign valid session tokens. Delete those
`WITH JWT ... KEY '[REDACTED]' WITH ISSUER KEY '[REDACTED]'` clauses (SurrealDB
then generates a random key), as was done in the initial migration.

## Landing page

[`apps/landing`](../apps/landing) is the Astro marketing site, built as static HTML. It
requires Node 22.22 or newer. From the repository root:

```bash
cp apps/landing/.env.example apps/landing/.env.local
pnpm dev:landing
pnpm --filter @studycall/landing type-check
pnpm build:landing
```

Set `PUBLIC_APP_URL` in `apps/landing/.env.local` to the actual app origin
before a production build. It falls back to `http://localhost:5180` for local
development. The static build is written to `apps/landing/dist`.

Landing page photo: [Sanket Mishra on Unsplash](https://unsplash.com/photos/a-girl-sitting-on-a-bench-using-a-laptop-vvE2GOnGudg).

## Deploy

### 1. Database

Create a SurrealDB Cloud instance, a namespace `studycall` and a database
`main`, and a database user for sp00ky and the API (Editor or Owner, it defines
the server-only indexes). Put the endpoint and user in `sp00ky.yml`
(`surrealdb.endpoint`, `surrealdb.username`), then store the password:

```bash
pnpm exec spky env set DB_PASSWORD
```

### 2. API Worker (Cloudflare)

In `apps/api/wrangler.jsonc`, set `vars.APP_ORIGIN` to the production web app's
URL and `SURREAL_NS` / `SURREAL_DB` to `studycall` / `main`. Then configure the
secrets and deploy:

```bash
pnpm --filter @studycall/api exec wrangler secret put SURREAL_URL          # https://YOUR-INSTANCE.surreal.cloud
pnpm --filter @studycall/api exec wrangler secret put SURREAL_USER
pnpm --filter @studycall/api exec wrangler secret put SURREAL_PASS
pnpm --filter @studycall/api exec wrangler secret put ANTHROPIC_API_KEY
pnpm --filter @studycall/api exec wrangler secret put ELEVENLABS_API_KEY
pnpm --filter @studycall/api exec wrangler secret put LLM_SHARED_SECRET    # openssl rand -base64 32
pnpm --filter @studycall/api run deploy
```

### 3. Voice agent

Use the same `LLM_SHARED_SECRET` value you stored in the API Worker's secrets.

```bash
ELEVENLABS_API_KEY=... API_URL=https://studycall-api.YOUR-SUBDOMAIN.workers.dev LLM_SHARED_SECRET=... pnpm setup:voice
pnpm --filter @studycall/api exec wrangler secret put ELEVENLABS_AGENT_ID
```

### 4. Web app and sync node (Sp00ky Cloud, free plan on Cloudflare)

Set `VITE_API_URL` in `apps/web/.env.production` to the Worker URL, then:

```bash
pnpm exec spky login
pnpm exec spky project create --slug studycall --plan free
pnpm exec spky deploy
```

`pnpm exec spky deploy` uploads the sync node as a Cloudflare Worker, applies the schema
to SurrealDB (`pnpm exec spky push` re-applies it after schema changes), builds the SPA
with the database and sync node URLs baked in, and publishes it on Workers
Static Assets. `pnpm exec spky status` lists the URLs; put the web app's in the
Worker's `APP_ORIGIN` (step 2).

## Using the MCP server

Create a key in the app under **AI access**, then for Claude Code:

```bash
claude mcp add --transport http talktobolo https://studycall-api.YOUR-SUBDOMAIN.workers.dev/mcp --header "Authorization: Bearer sc_..."
```

Tools: `list_courses`, `create_course`, `update_course`, `list_materials`,
`get_material`, `add_material`, `update_material`, `edit_material`, `add_pdf`
(https URL or base64), `delete_material`, `search_course`. The key signs in
through the `agent` access method, so SurrealDB enforces the same permissions
as in the web app; revoking it in the app cuts access within a minute.

## Models and usage

Model settings live in [`apps/api/wrangler.jsonc`](../apps/api/wrangler.jsonc).

| Setting | Purpose | Checked-in value |
| --- | --- | --- |
| `CLAUDE_MODEL` | Spoken replies and session recaps | `claude-opus-5-5` |
| `CLAUDE_PDF_MODEL` | PDF-to-Markdown conversion | `claude-opus-5-5` |
| `EMBEDDING_MODEL` | Course search embeddings | `@cf/qwen/qwen3-embedding-0.6b` |

The voice agent setup script also reads `CLAUDE_MODEL`; keep it aligned with
the API Worker when configuring the agent. PDF conversion processes ten pages
per request and falls back to the text layer if conversion fails.

Voice calls, model inference, document processing, and hosting use your
connected provider accounts. Check those accounts for current rates and limits.
