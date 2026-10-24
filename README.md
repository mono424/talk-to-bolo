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
notes, and TalkToBolo builds a knowledge graph for each course. Then study it
by voice in ChatGPT: ask the question you have been stuck on, try explaining
an idea out loud, or get quizzed on what you have covered.

Bring your material, ChatGPT, and a little curiosity.

| Explain it | Quiz me | I ask |
| --- | --- | --- |
| Walk through the material one idea at a time, with examples and check-ins. | Practice answering questions and find the topics that need another look. | Lead the conversation with your own questions. |

## From notes to understanding

1. **Bring what you are learning.** Add PDF slides, Markdown, or text notes to a course.
2. **Talk it through in ChatGPT.** Connect TalkToBolo to ChatGPT once, start Voice and ask for your course. Pick a study mode and take it at your own pace.
3. **Keep the conversation going.** ChatGPT saves the session and its recap to TalkToBolo and moves your place in the lecture forward, so the next session picks up there.

### Built around your course

- **Course context.** ChatGPT studies from your lecture material and searches across the course when more context is needed.
- **A knowledge graph per course.** As material is processed, SurrealDB Agent Memory builds the course's knowledge graph section by section. ChatGPT draws on it up to your place in each lecture.
- **Learning over time.** Set your place in each lecture. Reached material counts as seen, never as mastered.
- **What you understood, concept by concept.** While you study, ChatGPT maps the ideas of each lecture and what they build on, and notes what you showed about each one: right, shaky, a misconception, a missing piece. Your level per concept comes from that evidence, so the next session knows what to explain first, what to focus on and what you still miss for the full picture.
- **Your PDFs, kept as they are.** The original PDF stays in the app to read page by page, and its text and pictures become searchable for the tutor. Markdown and text notes are imported as they are.
- **Sources you can check.** Recaps, course search and the MCP tools link straight to the lecture page.
- **A record of each session.** Sessions saved from ChatGPT keep their recap, so you can return to them.
- **Study on the go with ChatGPT voice.** Connect ChatGPT to your account and it studies with you from your own courses: it picks up your lecture progress and past sessions, quizzes you on what you have covered, and saves the session and your progress back to TalkToBolo.
- **Course management from ChatGPT.** The same MCP server lets ChatGPT manage courses, add material, and search your notes, over OAuth.

## Getting started

Use **Node.js 22.22.0 or newer**, **pnpm 10.20.0**, and **Docker** for the local stack.
You will also need a configured Cloudflare account for document processing and
embeddings, and a SurrealDB Agent Memory Context for the course knowledge
graph. See the [setup guide](docs/setup.md#accounts-you-need) for account setup.

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

ChatGPT reaches the MCP server over HTTPS only. The
[local development guide](docs/setup.md#local-development) covers the tunnel for
trying the local stack from ChatGPT.

## Under the hood

| Part | Technology |
| --- | --- |
| Web app | SolidJS, TypeScript, Vite, Tailwind CSS |
| Landing page | Astro |
| Tutor and voice | ChatGPT, through the MCP server |
| Course knowledge graph | SurrealDB Agent Memory |
| API and document processing | Hono, Cloudflare Workers, Workflows, Workers AI |
| Data and search | SurrealDB with vector and full-text search |
| Live sync | sp00ky with a local SQLite store in the browser |

### Repository map

| Path | Contents |
| --- | --- |
| [`apps/web`](apps/web) | The study app |
| [`apps/landing`](apps/landing) | The marketing site |
| [`apps/api`](apps/api) | Document ingestion, search, and the MCP server for ChatGPT |
| [`schema`](schema) | Database schema and migrations |
| [`scripts`](scripts) | Maintenance scripts |
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
