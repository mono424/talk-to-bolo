<p align="center">
  <img src="assets/brand/studycall-ink.svg" alt="Bolo, the TalkToBolo squirrel" width="98" height="120" />
</p>

<h1 align="center">TalkToBolo</h1>

<p align="center">
  <strong>Talk it through. Make it click.</strong>
</p>

<p align="center">
  Your lecture notes. Your questions. Your AI study partner.
</p>

<p align="center">
  <a href="https://mono424.github.io/talk-to-bolo/">Visit the site</a> ·
  <a href="#meet-bolo">Meet Bolo</a> ·
  <a href="#getting-started">Getting started</a> ·
  <a href="docs/setup.md">Setup &amp; deployment</a> ·
  <a href="docs/brand/README.md">Brand &amp; design</a>
</p>

---

## Meet Bolo

Turn your course material into a conversation. Upload your lecture slides or
notes, start a voice call in your browser, and work through what you are
learning with Bolo. Ask the question you have been stuck on, try explaining
an idea out loud, or let Bolo quiz you.

No download needed. Bring your material, a microphone, and a little curiosity.

| Explain it | Quiz me | I ask |
| --- | --- | --- |
| Walk through the material one idea at a time, with examples and check-ins. | Practice answering questions and find the topics that need another look. | Lead the conversation with your own questions. |

## From notes to understanding

1. **Bring what you are learning.** Add PDF slides, Markdown, or text notes to a course.
2. **Talk it through.** Pick a study mode and start a live voice conversation. Interrupt, ask back, and take it at your own pace.
3. **Keep the conversation going.** Revisit the transcript and recap, then choose what to review next.

### Built around your course

- **Course context.** Bolo uses your lecture material and searches across the course when more context is needed.
- **Learning over time.** Set your place in each lecture. Bolo separates reached material from demonstrated understanding and uses SurrealDB Agent Memory for course concepts and student evidence when configured.
- **Your PDFs, kept as they are.** The original PDF stays in the app to read page by page, and its text and pictures become searchable for the tutor. Markdown and text notes are imported as they are.
- **Sources you can check.** The tutor cites the lecture pages it teaches from. Transcripts, recaps, course search and the MCP tools link straight to the page.
- **A voice conversation.** Speech, turn-taking, and interruptions run over WebRTC.
- **A record of each session.** Calls include transcripts and study recaps you can return to.
- **AI access.** An MCP server lets your assistant manage courses, add material, and search your notes with a personal API key.

## Getting started

Use **Node.js 22.22.0 or newer**, **pnpm 10.20.0**, and **Docker** for the local stack.
You will also need Anthropic and ElevenLabs API keys, plus a configured Cloudflare
account for document processing and embeddings. See the
[setup guide](docs/setup.md#accounts-you-need) for account and voice-agent setup.

```bash
git clone https://github.com/mono424/talk-to-bolo.git
cd talk-to-bolo
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars
```

Fill in `apps/api/.dev.vars` using the
[local development guide](docs/setup.md#local-development), then start the stack:

```bash
pnpm dev
```

| Service | Local URL |
| --- | --- |
| Web app | <http://localhost:5180> |
| API Worker | <http://localhost:8787> |
| Landing page, started separately | <http://localhost:4322> |

To work on the landing page:

```bash
cp apps/landing/.env.example apps/landing/.env.local
pnpm dev:landing
```

The published app is [talktobolo.stg.spky.cloud](https://talktobolo.stg.spky.cloud/).
Production landing-page links use that address by default; set `PUBLIC_APP_URL`
to override it.

### Useful commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Start the local database, sync node, app, and API |
| `pnpm dev:landing` | Start the Astro landing page |
| `pnpm type-check` | Check types across the workspace |
| `pnpm --filter @studycall/web build` | Build the web app |
| `pnpm build:landing` | Build the static landing page |
| `pnpm setup:voice` | Create or update the ElevenLabs voice agent with your configured credentials |

Voice calls need ElevenLabs to reach the API Worker. The
[voice setup instructions](docs/setup.md#local-development) cover the local tunnel
and shared secret.

## Under the hood

| Part | Technology |
| --- | --- |
| Web app | SolidJS, TypeScript, Vite, Tailwind CSS |
| Landing page | Astro |
| Voice | ElevenLabs Agents over WebRTC |
| Tutor and PDF conversion | Claude through the API Worker |
| API and document processing | Hono, Cloudflare Workers, Workflows, Workers AI |
| Data and search | SurrealDB with vector and full-text search |
| Live sync | sp00ky with a local SQLite store in the browser |

### Repository map

| Path | Contents |
| --- | --- |
| [`apps/web`](apps/web) | The study app |
| [`apps/landing`](apps/landing) | The marketing site |
| [`apps/api`](apps/api) | Voice calls, tutoring, document ingestion, search, and MCP |
| [`schema`](schema) | Database schema and migrations |
| [`scripts`](scripts) | Voice-agent setup |
| [`assets/brand`](assets/brand) | Canonical Bolo logo assets |
| [`docs/brand`](docs/brand) | Logo construction grid, geometry, and design board |

For architecture details, deployment, schema changes, and MCP configuration,
read the [setup and deployment guide](docs/setup.md).

## Meet the mark

Bolo is our curious little squirrel, drawn in clay rose, `#B86C68`. The logo
keeps a handdrawn character, with carefully constructed curves and an open
crescent curl.

[Logo &amp; design guidelines](docs/brand/README.md) ·
[Editable SVG](assets/brand/studycall-ink.svg) ·
[Construction grid](docs/brand/ink-construction.svg)

---

<p align="center"><strong>Your notes. Your questions. Your next aha moment.</strong></p>

Landing page photo by [Sanket Mishra on Unsplash](https://unsplash.com/photos/a-girl-sitting-on-a-bench-using-a-laptop-vvE2GOnGudg).
