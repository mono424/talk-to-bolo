# Studycall

Study by phone call. Add your lecture material to a course (PDF slides, notes,
Markdown), then call an AI tutor in the browser: it walks you through the
lecture, answers your questions, or quizzes you, out loud.

- **Voice:** ElevenLabs Agents (speech in, turn taking, interruptions, speech out) over WebRTC.
- **Brain:** Claude, through the API Worker, which ElevenLabs calls as a Custom LLM.
- **Data:** everything in SurrealDB: courses, material as Markdown, extracted images (bytes), the vector + full-text search index, calls and transcripts.
- **Sync:** sp00ky. The SolidJS app reads live queries from a local SQLite store; transcripts and processing progress show up as the server writes them.
- **AI access:** an MCP server, so Claude (or any MCP client) can create courses and add, edit and upload material.
- **Hosting:** sp00ky Cloud's free plan on Cloudflare (sync node + static SPA), plus our own Cloudflare Worker for the API.

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
| `schema/src/schema.surql` | The sp00ky schema: users, courses, materials, calls, transcript, API keys, access methods. `spky generate` turns it into `apps/web/src/schema.gen.ts`. |
| `apps/api/src/server-schema.surql` | Server-only tables (search chunks with embeddings, image bytes, PDF parts) and their HNSW/full-text indexes. Applied by the Worker; see the comment at the top. |
| `apps/web` | SolidJS app. Every read is a named live query in `src/lib/query.ts`. |
| `apps/api` | Cloudflare Worker (Hono): calls, LLM bridge, ingest Workflow, search, assets, MCP. |
| `scripts/setup-voice-agent.ts` | Creates or updates the ElevenLabs agent. |
| `sp00ky.yml` / `dev/sp00ky.yml` | Production (free plan, external SurrealDB) / local development. |

## Accounts you need

- **SurrealDB Cloud** instance (SurrealDB 3.x): the free plan needs an external database.
- **Sp00ky Cloud** (`spky login`), free plan.
- **Cloudflare**, Workers Paid plan ($5/month): the ingest Workflow needs more than the free plan's CPU time, and the Worker uses Workers AI.
- **Anthropic API key** (Claude).
- **ElevenLabs API key** with Agents access.

## Local development

Requirements: Node 22, pnpm 10, Docker, the keys above.

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

```bash
ELEVENLABS_API_KEY=... API_URL=https://<tunnel>.trycloudflare.com LLM_SHARED_SECRET=<same as .dev.vars> pnpm setup:voice
```

Put the printed agent id in `.dev.vars` as `ELEVENLABS_AGENT_ID`.

After a schema change: `pnpm generate`, then `spky migrate create <name> --path dev`.
**Open the new migration and check for `'[REDACTED]'`** before applying it: the
CLI copies access-method JWT keys from a redacted `INFO`, and a key literally
set to `[REDACTED]` lets anyone sign valid session tokens. Delete those
`WITH JWT ... KEY '[REDACTED]' WITH ISSUER KEY '[REDACTED]'` clauses (SurrealDB
then generates a random key), as was done in the initial migration.

## Deploy

### 1. Database

Create a SurrealDB Cloud instance, a namespace `studycall` and a database
`main`, and a database user for sp00ky and the API (Editor or Owner, it defines
the server-only indexes). Put the endpoint and user in `sp00ky.yml`
(`surrealdb.endpoint`, `surrealdb.username`), then store the password:

```bash
spky env set DB_PASSWORD
```

### 2. API Worker (Cloudflare)

```bash
cd apps/api
pnpm exec wrangler secret put SURREAL_URL          # https://<instance>.surreal.cloud
pnpm exec wrangler secret put SURREAL_USER
pnpm exec wrangler secret put SURREAL_PASS
pnpm exec wrangler secret put ANTHROPIC_API_KEY
pnpm exec wrangler secret put ELEVENLABS_API_KEY
pnpm exec wrangler secret put LLM_SHARED_SECRET    # openssl rand -base64 32
pnpm deploy                                        # prints https://studycall-api.<you>.workers.dev
```

In `wrangler.jsonc`, set `vars.APP_ORIGIN` to the web app's URL (step 4) and
`SURREAL_NS` / `SURREAL_DB` to `studycall` / `main`, then deploy again.

### 3. Voice agent

```bash
ELEVENLABS_API_KEY=... API_URL=https://studycall-api.<you>.workers.dev LLM_SHARED_SECRET=... pnpm setup:voice
pnpm --filter @studycall/api exec wrangler secret put ELEVENLABS_AGENT_ID
```

### 4. Web app and sync node (Sp00ky Cloud, free plan on Cloudflare)

Set `VITE_API_URL` in `apps/web/.env.production` to the Worker URL, then:

```bash
spky login
spky project create --slug studycall --plan free
spky deploy
```

`spky deploy` uploads the sync node as a Cloudflare Worker, applies the schema
to SurrealDB (`spky push` re-applies it after schema changes), builds the SPA
with the database and sync node URLs baked in, and publishes it on Workers
Static Assets. `spky status` lists the URLs; put the web app's in the
Worker's `APP_ORIGIN` (step 2).

## Using the MCP server

Create a key in the app under **AI access**, then for Claude Code:

```bash
claude mcp add --transport http studycall https://studycall-api.<you>.workers.dev/mcp --header "Authorization: Bearer sc_..."
```

Tools: `list_courses`, `create_course`, `update_course`, `list_materials`,
`get_material`, `add_material`, `update_material`, `edit_material`, `add_pdf`
(https URL or base64), `delete_material`, `search_course`. The key signs in
through the `agent` access method, so SurrealDB enforces the same permissions
as in the web app; revoking it in the app cuts access within a minute.

## Costs and models

- Calls and recaps use `CLAUDE_MODEL` (default `claude-opus-5-5`, at low effort
  for spoken replies). For snappier turn-taking, `claude-sonnet-5-5` or
  `claude-haiku-5-5` are drop-in values.
- PDF conversion uses `CLAUDE_PDF_MODEL` (default `claude-opus-5-5`), ten
  pages per request: roughly $1 to $2 per 50 pages. If a request fails, the
  page text layer is used instead.
- ElevenLabs Agents bill per call minute; Workers AI embeddings are a fraction
  of a cent per lecture.
