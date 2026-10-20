import { McpServer, OAuthError, OAuthErrorCode, createMcpHandler, requireBearerAuth, type AuthInfo } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Env } from './env';
import { MAX_PDF_BYTES, ensureServerSchema, fetchPdf, getOwnedMaterial, searchCourse, startIngest, storePdfAndIngest, validatePdf } from './service';
import { Surreal, fromBase64, recordId, signinRecord } from './surreal';

/**
 * Remote MCP server (Streamable HTTP, stateless) at /mcp, so an AI client
 * (Claude, ChatGPT, an agent) can read and write a user's courses and lecture
 * material directly.
 *
 * Auth: `Authorization: Bearer sc_...`, a personal API key from Settings.
 * The key signs in through the database's `agent` access method, which hands
 * back a session for the key's owner, so SurrealDB enforces the same table
 * permissions as in the web app. Only server-only work (PDF processing,
 * search) runs with the API's own database user, after an ownership check.
 */

interface Session {
  userId: string;
  token: string;
}

const sessions = new Map<string, { session: Session; until: number }>();

async function sessionForKey(env: Env, key: string): Promise<Session | null> {
  const hit = sessions.get(key);
  if (hit && hit.until > Date.now()) return hit.session;
  await ensureServerSchema(env);
  const token = await signinRecord(env, 'agent', { key });
  if (!token) return null;
  const userId = await Surreal.as(env, token).query<string>('RETURN $auth.id');
  const session = { userId, token };
  if (sessions.size > 500) sessions.clear();
  // Re-checked every minute, so a key revoked in Settings stops working
  // within a minute (the database session itself would last an hour).
  sessions.set(key, { session, until: Date.now() + 60 * 1000 });
  return session;
}

export async function handleMcp(req: Request, env: Env): Promise<Response> {
  const gate = requireBearerAuth({
    verifier: {
      async verifyAccessToken(token: string) {
        const session = token.startsWith('sc_') ? await sessionForKey(env, token) : null;
        if (!session) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Unknown or revoked TalkToBolo API key.');
        return {
          token,
          clientId: 'studycall-api-key',
          scopes: [],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          extra: { userId: session.userId, dbToken: session.token },
        };
      },
    },
  });
  const auth = await gate(req);
  if (auth instanceof Response) return auth;
  const origin = new URL(req.url).origin;
  return createMcpHandler(({ authInfo }) => buildServer(env, authInfo ?? auth, origin)).fetch(req, {
    authInfo: auth,
  });
}

// ── Tools ─────────────────────────────────────────────────────────────────

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

const LANG = z.string().regex(/^[a-z]{2}$/).describe('ISO 639-1 code the tutor speaks in calls, e.g. "en", "de".');

function buildServer(env: Env, auth: AuthInfo, origin: string) {
  const userId = auth.extra?.userId as string;
  const user = Surreal.as(env, auth.extra?.dbToken as string);
  const system = Surreal.system(env);
  const server = new McpServer({ name: 'TalkToBolo', version: '0.1.0' });

  // Images in lecture markdown are `asset:<id>` inside the app. AI clients see
  // absolute URLs instead, and may write either form back.
  const toExternal = (md: string) => md.replace(/\(asset:([A-Za-z0-9_-]+)\)/g, `(${origin}/assets/$1)`);
  const toInternal = (md: string) => md.replaceAll(`(${origin}/assets/`, '(asset:');

  // Errors go back to the AI client as tool errors. Database messages are kept
  // on purpose: they concern the caller's own data and tell the client how to
  // fix its input.
  const run = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err)) as T;
    }
  };

  server.registerTool(
    'list_courses',
    {
      title: 'List courses',
      description: "Lists the user's courses with how much material each has.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () =>
        text(
          await user.query(
            `SELECT id, title, description, language, tutor_notes, created_at,
               count(SELECT id FROM material WHERE course = $parent.id) AS materials
             FROM course ORDER BY created_at`,
          ),
        ),
      ),
  );

  server.registerTool(
    'create_course',
    {
      title: 'Create course',
      description: 'Creates a course. Lecture material is added to it with add_material or add_pdf.',
      inputSchema: z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        language: LANG.optional(),
        tutor_notes: z.string().optional().describe('Standing instructions for the voice tutor in this course.'),
      }),
    },
    ({ title, description, language, tutor_notes }) =>
      run(async () =>
        text(
          await user.query(
            `CREATE type::record($id) CONTENT {
               owner: $auth.id, title: $title, description: $description, language: $language ?? 'en',
               tutor_notes: $tutor_notes, color: $color
             } RETURN id, title`,
            {
              id: `course:k${crypto.randomUUID().replaceAll('-', '')}`,
              title,
              description: description ?? null,
              language: language ?? null,
              tutor_notes: tutor_notes ?? null,
              color: ['blue', 'orange', 'green', 'lilac', 'yellow', 'red'][Math.floor(Math.random() * 6)],
            },
          ),
        ),
      ),
  );

  server.registerTool(
    'update_course',
    {
      title: 'Update course',
      description: "Changes a course's title, description, language or tutor notes. Omitted fields stay as they are.",
      inputSchema: z.object({
        course_id: z.string(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        language: LANG.optional(),
        tutor_notes: z.string().optional(),
      }),
      annotations: { idempotentHint: true },
    },
    ({ course_id, ...patch }) =>
      run(async () => {
        const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
        const rows = await user.query<unknown[]>('UPDATE type::record($id) MERGE $patch RETURN id, title, language', {
          id: recordId('course', course_id),
          patch: fields,
        });
        return rows.length ? text(rows[0]) : fail('Course not found.');
      }),
  );

  server.registerTool(
    'list_materials',
    {
      title: 'List lecture material',
      description:
        'Lists the material of a course: id, title, kind, processing status (ready means the tutor can use it), size.',
      inputSchema: z.object({ course_id: z.string() }),
      annotations: { readOnlyHint: true },
    },
    ({ course_id }) =>
      run(async () =>
        text(
          await user.query(
            `SELECT id, title, kind, status, status_detail, error, page_count, chunk_count, image_count,
               string::len(content) AS characters, created_at, updated_at
             FROM material WHERE course = type::record($course) ORDER BY created_at`,
            { course: recordId('course', course_id) },
          ),
        ),
      ),
  );

  server.registerTool(
    'get_material',
    {
      title: 'Read lecture material',
      description:
        'Returns a material as Markdown. Long material comes in pages of `limit` characters: pass the returned next_offset to continue. Images are Markdown image links.',
      inputSchema: z.object({
        material_id: z.string(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1000).max(100_000).default(40_000),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ material_id, offset, limit }) =>
      run(async () => {
        const m = await user.query<{ id: string; title: string; status: string; content: string } | null>(
          'SELECT id, title, kind, status, content FROM ONLY type::record($id)',
          { id: recordId('material', material_id) },
        );
        if (!m) return fail('Material not found.');
        const content = toExternal(m.content);
        const end = Math.min(content.length, offset + limit);
        return text({
          id: m.id,
          title: m.title,
          status: m.status,
          total_characters: content.length,
          next_offset: end < content.length ? end : null,
          content: content.slice(offset, end),
        });
      }),
  );

  server.registerTool(
    'add_material',
    {
      title: 'Add lecture material',
      description:
        'Adds Markdown or plain-text lecture material to a course (notes, a script, a summary). It is indexed for the tutor automatically; use add_pdf for PDF files.',
      inputSchema: z.object({
        course_id: z.string(),
        title: z.string().min(1),
        content: z.string().min(1).describe('The material as Markdown.'),
      }),
    },
    ({ course_id, title, content }) =>
      run(async () => {
        const id = `material:k${crypto.randomUUID().replaceAll('-', '')}`;
        const rows = await user.query<unknown[]>(
          `CREATE type::record($id) CONTENT {
             owner: $auth.id, course: type::record($course), title: $title, kind: 'markdown', content: $content
           } RETURN id`,
          { id, course: recordId('course', course_id), title, content: toInternal(content) },
        );
        if (!rows?.length) return fail('Course not found.');
        await startIngest(env, id);
        return text({ id, status: 'processing', note: 'Indexing takes a few seconds; list_materials shows when it is ready.' });
      }),
  );

  server.registerTool(
    'update_material',
    {
      title: 'Replace lecture material',
      description: "Replaces a material's title and/or its whole Markdown content. For small changes use edit_material.",
      inputSchema: z.object({
        material_id: z.string(),
        title: z.string().min(1).optional(),
        content: z.string().min(1).optional(),
      }),
      annotations: { idempotentHint: true },
    },
    ({ material_id, title, content }) =>
      run(async () => {
        const id = recordId('material', material_id);
        const patch: Record<string, string> = {};
        if (title) patch.title = title;
        if (content) patch.content = toInternal(content);
        if (!Object.keys(patch).length) return fail('Nothing to change.');
        const rows = await user.query<unknown[]>('UPDATE type::record($id) MERGE $patch RETURN id', { id, patch });
        if (!rows?.length) return fail('Material not found.');
        if (content) await startIngest(env, id);
        return text({ id, reindexing: !!content });
      }),
  );

  server.registerTool(
    'edit_material',
    {
      title: 'Edit lecture material',
      description:
        'Replaces one exact passage of a material with new text (find and replace). old_text must occur exactly once; include enough surrounding text to make it unique.',
      inputSchema: z.object({ material_id: z.string(), old_text: z.string().min(1), new_text: z.string() }),
    },
    ({ material_id, old_text, new_text }) =>
      run(async () => {
        const id = recordId('material', material_id);
        const m = await user.query<{ content: string } | null>('SELECT content FROM ONLY type::record($id)', { id });
        if (!m) return fail('Material not found.');
        const content = toExternal(m.content);
        const at = content.indexOf(old_text);
        if (at < 0) return fail('old_text was not found in the material.');
        if (content.indexOf(old_text, at + 1) >= 0) return fail('old_text occurs more than once; include more context.');
        const next = content.slice(0, at) + new_text + content.slice(at + old_text.length);
        // Compare-and-set: a concurrent edit makes this one fail instead of being lost.
        const rows = await user.query<unknown[]>('UPDATE type::record($id) SET content = $content WHERE content = $before RETURN id', {
          id,
          content: toInternal(next),
          before: m.content,
        });
        if (!rows?.length) return fail('The material changed while editing. Read it again and retry.');
        await startIngest(env, id);
        return text({ id, reindexing: true });
      }),
  );

  server.registerTool(
    'add_pdf',
    {
      title: 'Add a PDF',
      description:
        'Adds a PDF (slides, script, paper) to a course from an https URL or base64 data. It is converted to Markdown with its images and indexed; that takes a minute or more, list_materials shows the progress.',
      inputSchema: z.object({
        course_id: z.string(),
        title: z.string().min(1).optional(),
        url: z.string().url().optional(),
        base64: z.string().optional().describe('The PDF file, base64-encoded. Use url instead when the file is online.'),
      }),
    },
    ({ course_id, title, url, base64 }) =>
      run(async () => {
        if (!url === !base64) return fail('Pass exactly one of url or base64.');
        if (base64 && base64.length > Math.ceil((MAX_PDF_BYTES * 4) / 3) + 1024) return fail('PDFs up to 30 MB are supported.');
        const file = url ? await fetchPdf(url) : { bytes: fromBase64(base64!.replace(/\s/g, '')), name: 'document.pdf' };
        // Validate before creating the material, so a bad file leaves nothing behind.
        validatePdf(file.bytes);
        const id = `material:k${crypto.randomUUID().replaceAll('-', '')}`;
        const rows = await user.query<unknown[]>(
          `CREATE type::record($id) CONTENT {
             owner: $auth.id, course: type::record($course), title: $title, kind: 'pdf', content: ''
           } RETURN id`,
          { id, course: recordId('course', course_id), title: title || file.name.replace(/\.pdf$/i, '') },
        );
        if (!rows?.length) return fail('Course not found.');
        await storePdfAndIngest(env, { id, owner: userId }, file.bytes, file.name);
        return text({ id, status: 'processing' });
      }),
  );

  server.registerTool(
    'delete_material',
    {
      title: 'Delete lecture material',
      description: 'Deletes a material with its images and search index. Cannot be undone.',
      inputSchema: z.object({ material_id: z.string() }),
      annotations: { destructiveHint: true },
    },
    ({ material_id }) =>
      run(async () => {
        const rows = await user.query<unknown[]>('DELETE type::record($id) RETURN BEFORE', {
          id: recordId('material', material_id),
        });
        return rows?.length ? text({ deleted: material_id }) : fail('Material not found.');
      }),
  );

  server.registerTool(
    'search_course',
    {
      title: 'Search a course',
      description: "Searches a course's material by meaning and keywords. Returns the best matching passages.",
      inputSchema: z.object({
        course_id: z.string(),
        query: z.string().min(1),
        material_id: z.string().optional().describe('Only search this material.'),
        limit: z.number().int().min(1).max(20).default(6),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ course_id, query, material_id, limit }) =>
      run(async () => {
        const courseId = recordId('course', course_id);
        const owned = await system.query<string | null>(
          'RETURN (SELECT VALUE id FROM type::record($id) WHERE owner = type::record($owner))[0]',
          { id: courseId, owner: userId },
        );
        if (!owned) return fail('Course not found.');
        if (material_id) await getOwnedMaterial(env, userId, material_id);
        const hits = await searchCourse(env, courseId, query, {
          k: limit,
          ownerId: userId,
          materialId: material_id ? recordId('material', material_id) : null,
        });
        return text(hits);
      }),
  );

  return server;
}
