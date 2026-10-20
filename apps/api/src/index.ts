import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv } from './env';
import { requireUser } from './auth';
import { endCall, startCall } from './calls';
import { handleChatCompletions } from './llm';
import { handleMcp } from './mcp';
import {
  createApiKey,
  ensureServerSchema,
  getOwnedCourse,
  getOwnedMaterial,
  markFailed,
  searchCourse,
  startIngest,
  storePdfAndIngest,
  readLimited,
  MAX_PDF_BYTES,
} from './service';
import { BadRequest, Surreal, UserError, fromBase64, recordId } from './surreal';

export { IngestMaterial } from './ingest';

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof UserError) return c.json({ error: err.message }, err.status);
  // Anything else may carry database internals: log it, answer generically.
  console.error(err);
  return c.json({ error: 'Something went wrong. Try again in a moment.' }, 500);
});

// The web app calls these from the browser.
app.use(
  '/api/*',
  cors({
    origin: (origin, c) => (c.env.APP_ORIGIN.split(',').map((o: string) => o.trim()).includes(origin) ? origin : null),
    allowHeaders: ['authorization', 'content-type', 'x-file-name'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    maxAge: 600,
  }),
);
app.use('/api/*', requireUser);

app.get('/health', (c) => c.json({ ok: true }));

// ── Calls ─────────────────────────────────────────────────────────────────

app.post('/api/calls', async (c) => {
  const body = await c.req.json<{ courseId?: string; materialId?: string | null; mode?: string }>();
  return c.json(await startCall(c.env, c.var.caller.userId, body));
});

app.post('/api/calls/:id/end', async (c) => {
  const body = await c.req.json<{ conversationId?: string | null }>().catch(() => ({}) as { conversationId?: string | null });
  const { recap } = await endCall(c.env, c.var.caller.userId, c.req.param('id'), body.conversationId ?? null);
  return c.json({ ok: true, recap });
});

// ElevenLabs' Custom LLM endpoint (configured as <origin>/llm/v1).
app.post('/llm/v1/chat/completions', (c) => handleChatCompletions(c.req.raw, c.env, c.executionCtx as ExecutionContext));

// ── Materials ─────────────────────────────────────────────────────────────

app.post('/api/materials/:id/pdf', async (c) => {
  const { userId } = c.var.caller;
  const material = await getOwnedMaterial(c.env, userId, c.req.param('id'));
  const bytes = await readLimited(c.req.raw.body, MAX_PDF_BYTES);
  const name = decodeURIComponent(c.req.header('x-file-name') ?? '') || null;
  try {
    await storePdfAndIngest(c.env, material, bytes, name);
  } catch (err) {
    // A file refused before processing started (not a PDF, too big) still
    // shows up on the material, so the row does not wait forever.
    if (err instanceof UserError) await markFailed(c.env, material.id, err.message);
    throw err;
  }
  return c.json({ ok: true });
});

app.post('/api/materials/:id/index', async (c) => {
  const material = await getOwnedMaterial(c.env, c.var.caller.userId, c.req.param('id'));
  if (material.kind === 'pdf' && !material.content.trim()) throw new BadRequest('Upload the PDF first.');
  await startIngest(c.env, material.id);
  return c.json({ ok: true });
});

app.post('/api/courses/:id/search', async (c) => {
  const { userId } = c.var.caller;
  const course = await getOwnedCourse(c.env, userId, c.req.param('id'));
  const { query } = await c.req.json<{ query?: string }>();
  const hits = await searchCourse(c.env, course.id, query ?? '', { k: 8, ownerId: userId });
  return c.json({ hits });
});

// ── API keys (for the MCP server) ─────────────────────────────────────────

app.post('/api/keys', async (c) => {
  const { name } = await c.req.json<{ name?: string }>();
  return c.json(await createApiKey(c.env, c.var.caller.userId, name ?? ''));
});

// ── Images extracted from PDFs ────────────────────────────────────────────

/**
 * Public by unguessable id (128 random bits), like a capability URL: <img>
 * tags cannot send the session token, and the ids only appear inside
 * material the owner can read.
 */
app.get('/assets/:id', async (c) => {
  const id = recordId('asset', c.req.param('id'));
  await ensureServerSchema(c.env);
  const row = await Surreal.system(c.env).query<{ b64: string; mime: string } | null>(
    'SELECT encoding::base64::encode(data) AS b64, mime FROM ONLY type::record($id)',
    { id },
  );
  if (!row) return c.notFound();
  return new Response(fromBase64(row.b64), {
    headers: {
      'content-type': row.mime,
      // An id never changes content; a day bounds how long a deleted image lingers.
      'cache-control': 'public, max-age=86400',
      'access-control-allow-origin': '*',
    },
  });
});

// ── MCP ───────────────────────────────────────────────────────────────────

app.all('/mcp', (c) => handleMcp(c.req.raw, c.env));

export default app;
