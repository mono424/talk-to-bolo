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
   │  job rows ──► SSP ──► /jobs/* │                  │
   ▼                              │                  ▼
 API (apps/api, a sp00ky Worker backend) ─────────────────────────────────
   /api/calls        start a call, ElevenLabs conversation token
   /jobs/*           jobs from the `job` outbox: re-index, lecture progress,
                     end a call and write its recap (apps/api/openapi.yml)
   /llm/v1/...       tutor prompt from SurrealDB + hybrid search -> Claude stream
   /api/materials    PDF upload -> `materials` bucket (kept) -> Workflow: images
                     (unpdf) -> Markdown (Claude) -> chunks with page numbers
                     -> embeddings (Workers AI) -> SurrealDB HNSW/BM25
   GET /api/materials/:id/pdf  the original PDF, for the in-app viewer
   /material-assets/:id  images extracted from PDFs
   /mcp              MCP server (Streamable HTTP), OAuth or personal API keys
   /oauth/*          account linking for ChatGPT and Claude
```

| Path | What |
| --- | --- |
| [`schema/src/schema.surql`](../schema/src/schema.surql) | The sp00ky schema: users, courses, materials, calls, transcript, API keys, access methods. `spky generate` turns it into `apps/web/src/schema.gen.ts`. |
| `apps/api/src/server-schema.surql` | Server-only tables (search chunks with embeddings and page numbers, extracted images, PDF parts) and their HNSW/full-text indexes. Applied by the Worker; see the comment at the top. |
| [`schema/buckets/materials.surql`](../schema/buckets/materials.surql) | The `materials` bucket: uploaded PDFs (in parts of at most 1 MiB) and the images extracted from them. Listed under `buckets:` in both sp00ky configs. |
| [`apps/web`](../apps/web) | SolidJS app. Every read is a named live query in `src/lib/query.ts`. |
| [`apps/api`](../apps/api) | Cloudflare Worker (Hono): calls, LLM bridge, ingest Workflow, search, assets, MCP. On Sp00ky Cloud it is the `api` Worker backend; `openapi.yml` lists its jobs. |
| [`schema/src/outbox/api.surql`](../schema/src/outbox/api.surql) | The `job` outbox: the web app writes a row, the sync node calls the API with its payload. |
| `scripts/setup-voice-agent.ts` | Creates or updates the ElevenLabs agent. |
| `sp00ky.yml` / `dev/sp00ky.yml` | Staging (free plan, shared SurrealDB, the API as a Worker backend) / local development. |

## Accounts you need

- **SurrealDB Cloud** instance running SurrealDB 3.x for production. Local development uses Docker.
- **Sp00ky Cloud** account for deploying the sync node and web app.
- **Cloudflare Workers Paid** account for the configured ingestion Workflow CPU limit and Workers AI embeddings.
- **Anthropic API key** (Claude).
- **ElevenLabs API key** with Agents access.
- **SurrealDB Agent Memory Context and API key** for the course knowledge graph and durable student evidence. This is a separate service from the SurrealDB SQL endpoint.

### Agent Memory and lecture progress

Set `AGENT_MEMORY_URL` to your Context's full data-plane base URL, for example
`https://YOUR-CONTEXT-HOST/api/v1/YOUR-CONTEXT-ID`, and store its key as
`AGENT_MEMORY_API_KEY` in `.dev.vars` or the vault (`spky env set`). Use a dedicated Context
per environment. The Worker key needs `scope:create`, `memory:write`, and
`memory:read` for the `talktobolo/*` subtree. Never expose it to the browser.
See [SurrealDB's Context setup](https://surrealdb.com/docs/agent-memory/quickstarts/surrealdb-cloud)
and [REST API reference](https://surrealdb.com/docs/agent-memory/reference/rest-api).

Ingestion uploads each search section separately to Agent Memory and waits for
graph extraction before marking the material ready. Each section uses a
synthetic `observedAt` ordered by lecture position. Owner, course, material and
revision determine its scope. Reindex existing material after configuring
Agent Memory to build its graph; content edits reset progress and use a fresh
revision scope so old facts cannot enter current retrieval.

On a lecture page, **Your place in the lecture** records the last section the
student reached. Uploading or opening slides does not advance this boundary.
In explain mode Bolo can teach the next section, then record it as reached
after the student confirms it. Quiz and question modes use reached sections.
Reaching a section establishes exposure, never mastery. Confirmed tutor/student
exchanges are ingested as experiential evidence with their original observation
time; generated replies alone are never evidence. Retried exchanges use stable
receipts and idempotency keys. Each section has its own student evidence scope,
so rewinding progress also excludes evidence about later sections.

Course graph reads use `asOf` and `include: ["facts"]`; raw passages are filtered
by the current material revision and reached position in SQL before retrieval.
This matters because Agent Memory's `asOf` does not gate raw uploaded passages.
See [temporal retrieval](https://surrealdb.com/docs/agent-memory/reasoning/temporal-validity).
The graph is partitioned by lecture revision, so knowledge is recalled from
relevant lectures without merging one student's evidence into course truth.

With neither setting present, lecture progress and permitted passages still
work; graph ingestion and durable student evidence are disabled. An unavailable
configured memory service never widens passage retrieval. It fails ingestion
with a retryable upload error and omits recalled memory during calls.

Deleting local material or calls removes the local records. Agent Memory
copies remain under their revision scopes and are no longer queried by Bolo.
For permanent erasure, use the Context's scoped erase operation as described in
[SurrealDB's forgetting guide](https://surrealdb.com/docs/agent-memory/operations/forget).

Run `pnpm --filter @studycall/api test` for the memory contract checks. With the
local Docker database running on port 8666, run
`BOLO_TEST_SURREAL=1 pnpm --filter @studycall/api test` to include real database
boundary and evidence checks. These create and remove a separate test namespace.

## Local development

### Database names

The local and production configurations use different namespace/database pairs.
Keep the API Worker and web app pointed at the same pair for each environment.

| Environment | Namespace | Database | Configuration |
| --- | --- | --- | --- |
| Local | `main` | `studycall` | [`dev/sp00ky.yml`](../dev/sp00ky.yml) |
| Staging | `talktobolo` | `main` | [`sp00ky.yml`](../sp00ky.yml) |

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
`SURREAL_DB=studycall`, `APP_ORIGIN=http://localhost:5180`. The local sync
node runs the `job` outbox against `wrangler dev` too, with the `JOB_TOKEN` from
`apps/api/wrangler.jsonc`.

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

### Materials and the bucket

A PDF upload is stored in the `materials` bucket and kept for as long as its
material exists: the app shows the original in its viewer, and the tutor,
course search, recaps and MCP tools cite its pages. A second upload to a
material that already has its PDF is refused (409); only a failed upload can be
replaced. Markdown and text files are imported straight into
`material.content` and never touch the bucket.

The bucket's `file:` backend needs a folder SurrealDB may write to. If local
uploads fail with a bucket error, check that the local SurrealDB allows
`/buckets/materials` (its bucket folder allowlist) and that the folder exists in
the container.

Existing deployments, once each:

1. Move bytes still stored in fields into the bucket: run
   `scripts/migrate-files-to-bucket.surql` as a system user until it reports
   nothing left.
2. Give the search chunks of PDFs indexed before page numbers existed their
   pages, so they can be cited (never reindex for this: that resets lecture
   progress). With the Worker's database credentials:

```bash
SURREAL_URL=... SURREAL_NS=... SURREAL_DB=... SURREAL_USER=... SURREAL_PASS=... pnpm backfill:pages
```

The script is idempotent: run it again until it reports no materials left.

### Schema changes

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

Production links default to [the deployed app](https://talktobolo.stg.spky.cloud/).
Set `PUBLIC_APP_URL` in `apps/landing/.env.local` to override that destination.
Development falls back to `http://localhost:5180`. The static build is written
to `apps/landing/dist`.

### GitHub Pages

The landing page is published at <https://mono424.github.io/talk-to-bolo/>.
The [`Deploy landing page` workflow](../.github/workflows/deploy-landing.yml)
checks, builds, and deploys it when landing-page code or build configuration
changes on `main`. It can also be run manually from GitHub Actions.

GitHub Pages is configured to publish from **GitHub Actions**. The workflow
supplies `SITE_URL` and `BASE_PATH` from the Pages configuration, so logos,
photos, fonts, and scripts work under the `/talk-to-bolo/` project path.

The Get started and Log in links use `https://talktobolo.stg.spky.cloud/`.
Set the repository Actions variable `PUBLIC_APP_URL` to override that destination,
then rerun the workflow.

To build the same project-path layout locally:

```bash
SITE_URL=https://mono424.github.io BASE_PATH=/talk-to-bolo PUBLIC_APP_URL= pnpm build:landing
```

Landing page photo: [Sanket Mishra on Unsplash](https://unsplash.com/photos/a-girl-sitting-on-a-bench-using-a-laptop-vvE2GOnGudg).

## Deploy

### Current staging app

The app is deployed at <https://talktobolo.stg.spky.cloud/>, by `spky deploy`
alone. The API is the `api` Worker backend in [`sp00ky.yml`](../sp00ky.yml):
the deploy bundles `apps/api/src/index.ts`, and the sync node runs it as a
Dynamic Worker with Workers AI and the `INGEST` Workflow.

Its environment is the vault keys listed under `apps.api.env` plus the plain
values there. The database login is the free plan's namespace user `owner`
(`pnpm exec spky project credentials`), so `SURREAL_AUTH_NS` is the namespace
and the password is the vault's `SURREAL_PASS`. Set a missing key with
`pnpm exec spky env set <NAME>`, then deploy:

```bash
pnpm exec spky deploy --yes
```

Bundling the Worker backend inside this pnpm workspace needs
`@spooky-sync/cli` 0.0.1-canary.345 or newer: canary.344 stops at
`esbuild: command not found`.

Agent Memory is off on staging for now: the vault's `AGENT_MEMORY_URL` holds
only the host, and with an incomplete URL every ingestion fails. To turn it on,
set it to the Context's full URL ending in `/api/v1/<context id>` (and check
`AGENT_MEMORY_API_KEY`), list both under `apps.api.env` again, and deploy.

Background work runs as jobs: the web app writes a row to the `job` outbox and
the sync node POSTs its payload to the path in
[`apps/api/openapi.yml`](../apps/api/openapi.yml) (re-indexing, lecture
progress, ending a call and writing its recap), retrying failures. Only the
paths under `worker.expose` are public: starting a call, search, PDF upload
and download, the OAuth consent calls, OAuth, MCP, the voice LLM and lecture
images. Frontend assets continue to use `/assets/`. Verify unauthenticated
`/mcp` returns an OAuth `401` challenge after deployment.

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
ELEVENLABS_API_KEY=... API_URL=https://talktobolo.stg.spky.cloud LLM_SHARED_SECRET=... pnpm setup:voice
pnpm --filter @studycall/api exec wrangler secret put ELEVENLABS_AGENT_ID
```

### 4. Web app and sync node (Sp00ky Cloud, free plan on Cloudflare)

The app uses its own origin for public service links. Leave `VITE_API_URL` in
`apps/web/.env.production` empty for this deployment:

| Service | Public URL |
| --- | --- |
| App | <https://talktobolo.stg.spky.cloud/> |
| API | <https://talktobolo.stg.spky.cloud/api/> |
| MCP server | <https://talktobolo.stg.spky.cloud/mcp> |
| PDF images | `https://talktobolo.stg.spky.cloud/material-assets/:id` |
| Voice LLM | <https://talktobolo.stg.spky.cloud/llm/v1> |

The hosting layer must route `/api/*`, `/mcp`, `/material-assets/*`, `/llm/*`, and
`/health` to the API Worker before the SPA fallback. A static SPA deployment
alone returns HTML at these paths and does not provide the backend. If the
API is hosted separately, set `VITE_API_URL` to its actual origin and use that
origin for the voice-agent setup as well.

Keep `/assets/*` on the frontend for Vite's JavaScript, styles and WebAssembly.
The API also retains its legacy `/assets/:id` image endpoint for existing links
on separately hosted API Workers.

Deploy the web app with:

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

Open **AI access** in the app:

- **Connect Claude** opens Claude's supported install dialog with TalkToBolo's
  name and server address already filled in.
- **Connect ChatGPT** copies the server address and opens ChatGPT Plugins.
  Choose **Add custom MCP server**, paste the address, select OAuth, then create
  and install the plugin. ChatGPT does not document an equivalent prefilled
  install link for arbitrary custom MCP servers.

Both clients use account approval on TalkToBolo's `/connect` page. No API key
is needed. OAuth uses dynamic client registration, S256 PKCE, short-lived
access tokens and rotating refresh tokens. Revoke a connection under **Keys and
connected apps**. Discovery is served under `/.well-known/`; `/oauth/register`,
`/oauth/authorize`, `/oauth/token` and `/oauth/revoke` belong to the API Worker.
Route these paths to the Worker alongside `/mcp` when using one app origin.

The client setup follows [Claude's install-link documentation](https://claude.com/docs/connectors/building/directory-vs-custom#share-an-install-link)
and [OpenAI's custom MCP setup](https://developers.openai.com/plugins/deploy/connect-chatgpt).

For Claude Code or another bearer-token client, create a key under **AI access**:

```bash
claude mcp add --transport http talktobolo https://talktobolo.stg.spky.cloud/mcp --header "Authorization: Bearer sc_..."
```

Tools: `list_courses`, `create_course`, `update_course`, `list_materials`,
`get_material`, `add_material`, `update_material`, `edit_material`, `add_pdf`
(https URL or base64), `delete_material`, `search_course`. Search hits and PDF
materials carry page numbers and links into the app's viewer, so assistants can
cite pages; the text of a PDF is derived from it and cannot be edited, only its
title. The key signs in
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
